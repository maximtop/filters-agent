import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createOctokit, fetchIssue } from '../github/fetch-issue';
import { buildReplayCase } from './case-builder';
import { pinCheckout, restoreCheckout } from '../repo/checkout-pinner';
import { createToolRegistry } from '../agent/tool-factory';
import { createRuntimeTraceRecorder } from '../tracer/runtime-recorder';
import { RunMode } from '../types/trace';
import { gradeReplay, writeReplayReport } from './replay-grader';
import { createLogger } from '../logger/logger';
import { bootstrapSessionBrowser } from '../analyzer/session-browser';
import { extractReport, IntakeExtractionKind } from '../intake/extract-report';
import { reportToIssueFacts } from '../intake/report-facts';
import type { BrowserSession } from '../browser/browser-session';
import { createPiRuntimeFromConfig, createConfiguredSingleShotClient } from '../pi/llm-wiring';
import { createRunUsageCollector } from '../pi/usage-collector';
import {
    runReplaySession,
    replayOutcomeToGradingInput,
    ReplayGradingStatus,
} from './replay-session';
import {
    ReplayNotGradeableError,
    writeReplayFailureArtifact,
    type ReplayRunFailure,
} from './replay-failure';
import type { Finding } from '../types/site-analysis';
import { deriveReproductionSignal } from './reproduction-signal';
import type { AppConfig } from '../config/config';
import type { ReplayComparison } from '../types/replay';
import type { UsageRatesTable } from '../types/usage-summary';

/**
 * Options for {@link runReplay}.
 */
export interface ReplayRunOptions {
    /**
     * Directory to write Markdown comparison artifacts to.
     */
    replaysDir: string;

    /**
     * Directory to write run traces to.
     */
    tracesDir: string;

    /**
     * Whether to run in dry-run mode. Always true for replay — reserved for future non-dry-run
     * path.
     */
    dryRun: boolean;

    /**
     * Override the default LLM model.
     */
    model?: string;

    /**
     * Whether verbose logging is enabled.
     */
    verbose?: boolean;

    /**
     * If set, the runner validates that the resolved issue's closure type matches this value. A
     * mismatch causes an early rejection with a clear error message.
     *
     * Maps to the `--closure-type` CLI flag. For single-issue replay this acts as a guard against
     * operator error (e.g., expecting a merged-fix replay when the issue was closed as
     * cannot-reproduce).
     */
    closureType?: string;

    /**
     * Maximum issue age for replay selection (e.g. "7d", "30d", "90d").
     *
     * Maps to the `--recency` CLI flag. **Scaffolding for future batch replay.** On single-issue
     * replay, the flag is accepted and logged but does not filter — the issue number already
     * selects exactly one issue. When batch replay is implemented, this field will control which
     * closed issues are eligible.
     */
    recency?: string;

    /**
     * Caller cancellation; aborted runs seal as `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Frozen per-run model rates for cost attribution; absent → `{}` → `costUsd: null`, honest
     * unknown.
     */
    usageRates?: UsageRatesTable;
}

/**
 * Run a complete replay: build the case, pin the checkout, run the pi session, grade, and write
 * artifacts.
 *
 * @param config - The validated application config.
 * @param issueNumber - The closed issue to replay.
 * @param options - Replay run options (output directories, model override, verbosity).
 * @returns The replay comparison result of a graded run.
 * @throws ReplayNotGradeableError when the run sealed without an accepted verdict — the sealed
 *   trace and the typed failure artifact are written first, and no rubric is produced.
 */
export async function runReplay(
    config: AppConfig,
    issueNumber: number,
    options: ReplayRunOptions,
): Promise<ReplayComparison> {
    const octokit = createOctokit(config.github);
    const runId = randomUUID();

    const logger = createLogger({ verbose: options.verbose ?? false });

    // 1. Build the ReplayCase
    const goldCase = await buildReplayCase(config.github, issueNumber, octokit);

    // 2. Validate --closure-type against the resolved case (Finding 6)
    if (options.closureType && goldCase.closureType !== options.closureType) {
        throw new Error(
            `Closure type mismatch: --closure-type ${options.closureType} was requested, ` +
                `but issue #${issueNumber} is classified as ${goldCase.closureType}. ` +
                'Omit --closure-type to accept the resolved type, or specify the correct type.',
        );
    }

    // 3. Log --recency (scaffolding for future batch replay — Finding 5)
    if (options.recency) {
        logger.info(
            `--recency flag set to "${options.recency}". ` +
                'On single-issue replay this does not filter — the issue number already selects exactly one issue. ' +
                'This flag is scaffolding for future batch replay mode.',
        );
    }

    // 4. Pin the checkout to the base commit — only for merged-fix cases (Finding 1)
    const checkoutPath = config.repositoryPath;
    let previousRef: string | undefined;
    if (checkoutPath && goldCase.baseCommit) {
        previousRef = pinCheckout(checkoutPath, goldCase.baseCommit);
    }

    const artifactsDir = join(process.cwd(), 'artifacts', `replay-${issueNumber}`);
    let browserSession: BrowserSession | undefined;

    try {
        // 5. Set up the recorder (with apiKey redaction, like every other mode) and the optional
        // browser session + validator tools, then the registry (Finding 2).
        const recorder = createRuntimeTraceRecorder({
            runId,
            issueNumber,
            mode: RunMode.Replay,
            exactSecrets: [config.llm.apiKey],
        });

        // One pi runtime per run: the bootstrap client and the replay session share this instance.
        const piRuntime = await createPiRuntimeFromConfig(config.llm, options.model);
        const usageCollector = createRunUsageCollector({ rates: options.usageRates });

        // Fetch + extract once: the bootstrap browser derives its repro profile from the facts.
        const raw = await fetchIssue(config.github, issueNumber);
        const extractionClient = createConfiguredSingleShotClient(
            piRuntime,
            piRuntime.reasoningModel,
            config.llm,
            { logger, usageCollector },
        );
        const extraction = await extractReport(raw, {
            client: extractionClient,
            logger,
            signal: options.signal,
        });
        if (extraction.kind === IntakeExtractionKind.Skipped) {
            throw new Error(`Issue #${issueNumber} skipped: ${extraction.reason}`);
        }
        const facts = reportToIssueFacts(raw, extraction.report);

        const bootstrap = await bootstrapSessionBrowser({
            config,
            facts,
            runtime: piRuntime,
            artifactsDir,
            recorder,
            logger,
            usageCollector,
        });
        browserSession = bootstrap.browserSession;
        const browserTools = bootstrap.browserTools;
        const browserAvailable = browserTools !== undefined;

        // The replayer owns no list-catalog walk, so the registry's placement-map generation is
        // this run's single tree traversal for the checkout tools.
        const registry = await createToolRegistry({
            githubConfig: config.github,
            allowedIssueNumber: issueNumber,
            checkoutPath,
            browserTools,
        });

        // 6. Run the pi session.
        const { outcome, trace } = await runReplaySession({
            config,
            issueNumber,
            model: options.model,
            recorder,
            registry,
            artifactsDir,
            logger,
            signal: options.signal,
            runtime: piRuntime,
            usageCollector,
        });

        // 7. Write the sealed trace before anything can fail: a run that cannot be graded must
        // still be diagnosable from its own trace.
        mkdirSync(options.tracesDir, { recursive: true });
        const tracePath = join(options.tracesDir, `trace-${runId}.json`);
        writeFileSync(tracePath, JSON.stringify(trace, null, 2));

        // 8. Grade only an accepted verdict. Every other seal is an infrastructure ending, not an
        // agent answer: it leaves a typed failure artifact and never reaches the grader, so an
        // outage cannot be counted as a real cannot-reproduce agreement.
        const grading = replayOutcomeToGradingInput(outcome, logger);
        if (grading.status === ReplayGradingStatus.NotGradeable) {
            const failure: ReplayRunFailure = {
                issueNumber,
                runId,
                reason: grading.reason,
                detail: grading.detail,
                traceOutcome: trace.outcome ?? null,
                tracePath,
            };
            throw new ReplayNotGradeableError(
                failure,
                writeReplayFailureArtifact(options.replaysDir, failure),
            );
        }
        const agentOutput = grading.output;
        const gradeResult = gradeReplay(goldCase, agentOutput);

        // 9. Prepare the MD comparison artifact path
        mkdirSync(options.replaysDir, { recursive: true });
        const mdArtifactPath = join(options.replaysDir, `replay-${issueNumber}-${runId}.md`);

        // Derive the decoupled reproduction signal from the browser findings and render the
        // MD comparison. With no browser session (reasoning-only fallback or launch failure)
        // `reproduced` stays 'n/a'.
        const findings: Finding[] = browserTools?.analyzer.getFindings() ?? [];
        const reproduced = deriveReproductionSignal(findings, browserAvailable);
        writeReplayReport(goldCase, agentOutput, gradeResult, reproduced, mdArtifactPath);

        return {
            agentOutcome: agentOutput.agentOutcome,
            agentRules: agentOutput.agentRules,
            agentPlacement: agentOutput.agentPlacement,
            rubric: gradeResult.rubric,
            judgeVerdict: gradeResult.judgeVerdict,
            reproduced,
            mdArtifactPath,
        };
    } finally {
        // 10. Restore checkout — only if we pinned it
        if (checkoutPath && previousRef) {
            restoreCheckout(checkoutPath, previousRef);
        }
        // 11. Close the browser session if one was constructed
        if (browserSession) {
            await browserSession.close();
        }
    }
}

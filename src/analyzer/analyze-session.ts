/**
 * Analyze-mode pi session wiring: builds and runs the pi session for one issue analysis — pi
 * runtime, optional browser bootstrap, the frozen analyze tool set adapted from the legacy
 * registry, the submit_analysis terminal tool, prompt documents, budgets — and seals the run trace
 * from the pi outcome. The legacy text-sealing protocol is gone from analyze: the typed terminal
 * payload is the only outcome channel and no fenced-JSON prose is ever parsed. The registry→pi
 * adaptation, trace recording, and seal mapping live in the shared src/pi modules.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createToolRegistry } from '../agent/tool-factory';
import { ToolName } from '../agent/tool-names';
import type { AppConfig } from '../config/config';
import { fetchIssue } from '../github/fetch-issue';
import { extractReport, IntakeExtractionKind } from '../intake/extract-report';
import { reportToIssueFacts } from '../intake/report-facts';
import type { Logger } from '../logger/logger';
import { createPiRuntimeFromConfig, createConfiguredSingleShotClient } from '../pi/llm-wiring';
import type { TerminalToolController } from '../pi/terminal-tool';
import { buildModeTerminal, runModeSession, type ModeSessionResult } from '../session/mode-session';
import { buildRegistrySessionTools } from '../session/registry-session-tools';
import { bootstrapSessionBrowser } from './session-browser';
import { PromptDocumentName } from '../prompts/prompt-documents';
import type { FixOutcome } from '../pr/fix-outcome';
import { FixOutcomeSchema } from '../pr/fix-outcome';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { RunUsageCollector } from '../pi/usage-collector';

/**
 * Turn cap, carried over from the legacy analyze loop's maxIterations of 20.
 */
const ANALYZE_MAX_TURNS = 20;

/**
 * What one analyze session needs: configuration, issue identity, the run recorder, and the
 * caller-owned signal for cancellation.
 */
export interface AnalyzeSessionOptions {
    /**
     * Validated application configuration (LLM provider, GitHub credentials, browser knobs).
     */
    config: AppConfig;

    /**
     * The issue number being analyzed.
     */
    issueNumber: number;

    /**
     * Reasoning-model override from `--model`; defaults to `config.llm.model`.
     */
    model?: string;

    /**
     * The run's trace recorder.
     */
    recorder: TraceRecorder;

    /**
     * Root of the workspace the run's artifacts and trace are rooted at.
     */
    workspaceRoot: string;

    /**
     * Application logger for browser bootstrap and run diagnostics.
     */
    logger: Logger;

    /**
     * Caller cancellation; aborted runs seal as `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Optional run-scoped usage collector: the loop session and the metered browser vision client
     * feed it, and the sealed trace carries the rendered summary block.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Result of one analyze session: the sealed pi outcome and the run trace it sealed.
 */
export type AnalyzeSessionRun = ModeSessionResult<FixOutcome>;

/**
 * Build the analyze terminal tool, wrapped so every submission — accepted or rejected — lands in
 * the run trace.
 *
 * @param recorder - The run trace recorder.
 * @returns The terminal controller whose tool records each call.
 */
function buildAnalyzeTerminal(recorder: TraceRecorder): TerminalToolController<FixOutcome> {
    return buildModeTerminal(ToolName.SubmitAnalysis, FixOutcomeSchema, recorder);
}

/**
 * Run one analyze session on pi and seal its trace.
 *
 * @param options - The session options.
 * @returns The sealed outcome and trace.
 */
export async function runAnalyzeSession(
    options: AnalyzeSessionOptions,
): Promise<AnalyzeSessionRun> {
    const { config, issueNumber, recorder, logger } = options;
    const artifactsDir = join(options.workspaceRoot, 'artifacts', `issue-${issueNumber}`);
    mkdirSync(artifactsDir, { recursive: true });

    const runtime = await createPiRuntimeFromConfig(config.llm, options.model);

    // Fetch + extract once per run: the extracted facts feed the browser bootstrap, whose own
    // fetch/parse was deleted with the deterministic parser.
    const raw = await fetchIssue(config.github, issueNumber);
    const extractionClient = createConfiguredSingleShotClient(
        runtime,
        runtime.reasoningModel,
        config.llm,
        {
            logger,
            usageCollector: options.usageCollector,
        },
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

    const { browserSession, browserTools } = await bootstrapSessionBrowser({
        config,
        facts,
        runtime,
        artifactsDir,
        recorder,
        logger,
        usageCollector: options.usageCollector,
    });

    // The analyzer session owns no list-catalog walk, so the registry's placement-map generation
    // is this run's single tree traversal for the checkout tools.
    const registry = await createToolRegistry({
        githubConfig: config.github,
        allowedIssueNumber: issueNumber,
        checkoutPath: config.repositoryPath,
        browserTools,
    });
    try {
        return await runModeSession<FixOutcome>({
            runtime,
            llm: config.llm,
            recorder,
            terminalToolName: ToolName.SubmitAnalysis,
            renderTask: (prompts, terminalToolName) =>
                prompts.render(PromptDocumentName.AnalyzeTask, {
                    issueNumber: String(issueNumber),
                    terminalToolName,
                }),
            terminal: buildAnalyzeTerminal(recorder),
            tools: buildRegistrySessionTools(registry, recorder),
            maxTurns: ANALYZE_MAX_TURNS,
            workDir: artifactsDir,
            logger,
            signal: options.signal,
            usageCollector: options.usageCollector,
        });
    } finally {
        if (browserSession) {
            await browserSession.close();
        }
    }
}

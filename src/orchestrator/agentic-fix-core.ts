/**
 * The agentic investigation mode: one complete model-owned lifecycle from issue intake through
 * browser verification, where the model itself selects the environment, extension, settings,
 * profiles, diagnostics, and the typed terminal decision through the live AgentRuntime registry.
 */
import { createHash, randomUUID } from 'node:crypto';
import { BrowserMode } from '../types/browser-mode';
import { mkdirSync } from 'node:fs';
import * as v from 'valibot';
import { recordPreflightDiagnostic } from '../local/preflight-diagnostic-log';
import { captureIssueScreenshots } from '../analyzer/issue-screenshot-capture';
import type { CoreConfig } from '../config/config';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type ProvisionalEnvironmentDisposition,
} from '../environment/filtering-environment';
import { NOT_OBSERVED_TEXT } from '../environment/environment-proofs';
import { createLogger } from '../logger/logger';
import { FixOutcomeKind } from '../pr/fix-outcome';
import { createPiRuntimeFromConfig, createVisionClient } from '../pi/llm-wiring';
import { runFixSession } from './fix-session';
import { FixTerminalSource } from './fix-session-seal';
import { createTrustedValidationContext } from '../validator/trusted-validation-context';
import { createRuntimeTraceRecorder } from '../tracer/runtime-recorder';
import {
    noPatchVerdictIsSessionBound,
    CurrentRulesResolutionStatus,
    EffectiveMode,
    ExtensionMode,
    FixRunResultSchema,
    FixRunStatus,
    ReproductionSettingsStatus,
    VerificationStatus,
    type FixRunResult,
} from '../types/fix-run-result';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import { RunMode, TraceEventType } from '../types/trace';
import { enforceCandidateSafety } from './candidate-safety';
import { branchNameDomain, deriveBranchName } from './fix-branch-name';
import {
    candidatePatchFromOutcome,
    deriveFixRunStatus,
    resolveCandidateVerdict,
} from './candidate-verdict';
import { selectCandidateValidation } from './candidate-validation-selection';
import { selectRepresentativeRejectedCandidateScreenshots } from './rejected-validation-evidence';
import { assembleFixRunResult } from './fix-result-assembly';
import { collectMissingInformation, logMissingInformation } from './fix-run-missing-information';
import { AgentRuntime } from './agent-runtime';
import { wireRuntimeExecutors, type RuntimeExecutorWiring } from './agent-runtime-executor-wiring';
import { BrowserExtensionExecutorName } from '../environment/executor-name';
import { prepareRunExtension } from './pre-run-preparation';
import type { PreparedExtension } from '../local/prepared-extension';
import type { AgentRuntimeEnvironmentEvidence } from './agent-runtime-session-evidence';
import { isTargetEnvironmentFallbackReason } from '../types/browser-fallback-origin';
import {
    type FixCoreDependencies,
    type FixCoreIssueInput,
    type FixCoreOptions,
} from './fix-core-inputs';
import { resolveRuleGuidanceSource } from './fix-core-inputs';
import {
    acceptedCandidateDisposition,
    deriveAgenticVerificationStatus,
    environmentSelectionRunStatus,
    materializeIssueScreenshots,
    normalizeCoreIssue,
    AGENTIC_INVESTIGATION_BUDGET_MS,
    AGENTIC_ITERATION_BACKSTOP,
    FixRunResultContractError,
    type CoreBrowserState,
    type CoreResultContext,
} from './fix-core-context';
import {
    emptyArtifactPaths,
    makeCoreResult,
    persistBrowserLog,
    persistTrace,
} from './pre-agent-artifacts';
import {
    describeVerifiedCandidateBindingFailure,
    persistAgentSettingsProof,
    selectConfigurationSpecificEnvironmentMatrix,
    serializeAgentBrowserSessions,
    serializeAgentExtensionProvenance,
    serializeAgentSettingsEvidence,
    serializeConfigurationSpecificEnvironmentMatrix,
    serializeVerifiedCandidateBinding,
    symptomFromTerminal,
} from './agentic-run-evidence';
import { completeFixResultAfterEnvironmentCleanup } from './fix-environment-lifecycle';

/**
 * Run one complete model-owned lifecycle from issue intake through browser verification.
 *
 * Infrastructure prepares the pinned repository, the KnowledgeBase or run instruction, and the
 * run's extension build — the operator-pinned release, an operator-preloaded directory, or the
 * instruction's own `## Preparation` session — before the runtime exists. The model itself selects
 * settings, browser profiles, diagnostics, candidates, and the typed terminal decision through the
 * live AgentRuntime registry. A run whose instruction declares a file-backed verification method
 * never reaches here: every calling face refuses it at the earliest point it holds the loaded
 * instruction, before this core is ever invoked (`fileBackedApplicationRefusalDetail` in
 * `knowledge/instruction-application.ts`), so this core no longer repeats that check itself.
 *
 * @param config - GitHub-independent LLM and browser configuration.
 * @param issue - Prompt-safe local issue snapshot and integrity-addressed attachments.
 * @param options - Artifact, repository, and run-instruction boundaries.
 * @param dependencies - Provider and browser seams used by focused tests.
 * @returns Locked browser-first result with model-selected environment provenance.
 */
export async function runAgenticFixCore(
    config: CoreConfig,
    issue: FixCoreIssueInput,
    options: FixCoreOptions,
    dependencies: FixCoreDependencies,
): Promise<FixRunResult> {
    const normalizedIssue = normalizeCoreIssue(issue);
    const facts = normalizedIssue.facts;
    if (facts.issueNumber !== normalizedIssue.rawIssue.number) {
        throw new Error(
            `Issue facts ${facts.issueNumber} do not match local snapshot ` +
                normalizedIssue.rawIssue.number,
        );
    }
    const issueNumber = facts.issueNumber;
    const domain = branchNameDomain(deriveBranchName(issueNumber, facts.reportedSiteUrls));
    const requestedBrowserMode = options.browserMode ?? BrowserMode.Auto;
    const allowedTargetUrls = facts.reportedSiteUrls;
    const reportedUrl = allowedTargetUrls[0];
    const resultContext: CoreResultContext = {
        issueNumber,
        domain,
        requestedBrowserMode,
        repository: options.repository ?? null,
        baseSha: options.baseSha ?? null,
        filtersRepository: options.filtersRepository ?? null,
        filtersBaseSha: options.filtersBaseSha ?? null,
        reproductionSettingsStatus: ReproductionSettingsStatus.NotProvided,
        reproductionSettingsDetail:
            'The model has not yet selected or proven the reporter extension settings.',
        // The locked result carries the extraction's reporter settings so the publisher gates on
        // what this run's own extraction read, never on a publication-time re-parse.
        reporterSettings: {
            settingsImportUrl: facts.settingsImportUrl,
            enabledFilters: facts.enabledFilters,
            product: facts.product,
        },
    };
    let browserState: CoreBrowserState = {
        effectiveMode: EffectiveMode.Reasoning,
        usable: false,
        fallbackReason: null,
        fallbackDetail: null,
    };
    mkdirSync(options.artifactsDir, { recursive: true });
    const recorder = createRuntimeTraceRecorder({
        runId: randomUUID(),
        issueNumber,
        mode: RunMode.Fix,
        exactSecrets: [config.llm.apiKey],
    });
    if (!reportedUrl || !config.repositoryPath || !options.agentRuntime) {
        const tracePath = persistTrace(recorder.end('failed'), options.artifactsDir);
        return makeCoreResult(
            resultContext,
            'failed',
            browserState,
            'unavailable',
            'Agent runtime requires a reported URL, pinned AdguardFilters checkout, and ' +
                'extension source/cache configuration.',
            null,
            emptyArtifactPaths(tracePath),
            'indeterminate',
            CurrentRulesResolutionStatus.NotAttempted,
            undefined,
            InfrastructureFailureReason.EnvironmentUnavailable,
        );
    }
    const piRuntime =
        dependencies.piRuntime ?? (await createPiRuntimeFromConfig(config.llm, options.model));
    const visionClient =
        dependencies.vision ??
        createVisionClient(piRuntime, config.llm, {
            logger: createLogger({ verbose: options.verbose ?? false }),
            usageCollector: dependencies.usageCollector,
        });
    // One pino logger for the whole session half: the fix session logs its wiring through it, and
    // the post-seal missing-information harvest logs each record beside the same stream.
    const logger = createLogger({ verbose: options.verbose ?? false });
    // The run's executor set resolves before any extension work: AgentRuntime.create resolves the
    // identical set from the identical requested names and registry right after this, but the
    // extension is a paid download and preparation session that must never run for an executor set
    // that never consumes it (a non-extension-only run) — such an adapter reads no
    // `preparedExtension` and launches with `extension: none` regardless. Resolving here first,
    // before that cost, also means an unknown requested name fails named with the registered set
    // here instead of only once AgentRuntime.create exists — the same registry, the same message.
    let executorWiring: RuntimeExecutorWiring;
    try {
        executorWiring = wireRuntimeExecutors({
            issueFacts: facts,
            requestedExecutors: options.agentRuntime.executors,
            registry: dependencies.agentRuntime?.filteringExecutors,
        });
    } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error({ err }, 'the run executor set could not be resolved');
        recorder.record(TraceEventType.Error, {
            phase: 'agent_runtime',
            message: err.message,
        });
        const tracePath = persistTrace(recorder.end('failed'), options.artifactsDir);
        return makeCoreResult(
            resultContext,
            'failed',
            browserState,
            'unavailable',
            `Agent runtime failed: ${err.message}`,
            null,
            emptyArtifactPaths(tracePath),
            'indeterminate',
            CurrentRulesResolutionStatus.NotAttempted,
            undefined,
            InfrastructureFailureReason.EnvironmentUnavailable,
        );
    }
    const needsPreparedExtension = executorWiring.executors.some(
        (executor) => executor.name === BrowserExtensionExecutorName,
    );
    // The run's one extension build is prepared before any runtime exists: the instruction's model
    // preparation session, or the pinned prebuilt release. A failure here fails the run named with
    // the full captured output, on this one attempt — the empty-artifact pre-session pattern, with
    // the trace persisted beside it. Skipped entirely when no resolved executor consumes it.
    let preparedExtension: PreparedExtension | undefined;
    if (needsPreparedExtension) {
        try {
            preparedExtension = await prepareRunExtension(
                {
                    recorder,
                    llm: config.llm,
                    piRuntime,
                    logger,
                    usageCollector: dependencies.usageCollector,
                },
                {
                    artifactsDir: options.artifactsDir,
                    instruction: options.instruction,
                    signal: options.signal,
                },
                {
                    runPreparationSession: dependencies.runPreparationSession,
                    downloadPinnedExtensionRelease: dependencies.downloadPinnedExtensionRelease,
                },
            );
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            const message = err.message;
            // Logged in full (message, stack, cause) before mapping to the typed infrastructure
            // failure below — never swallowed into a bare code.
            logger.error({ err }, 'Pre-run extension preparation failed');
            recorder.record(TraceEventType.Error, {
                phase: 'extension_preparation',
                message,
            });
            const tracePath = persistTrace(recorder.end('failed'), options.artifactsDir);
            return makeCoreResult(
                resultContext,
                'failed',
                browserState,
                'unavailable',
                message,
                null,
                emptyArtifactPaths(tracePath),
                'indeterminate',
                CurrentRulesResolutionStatus.NotAttempted,
                undefined,
                InfrastructureFailureReason.EnvironmentUnavailable,
            );
        }
    }
    let runtime: AgentRuntime | undefined;
    let provisionalResult: FixRunResult | undefined;
    let failureDisposition: ProvisionalEnvironmentDisposition | undefined;
    try {
        const localIssueScreenshots = materializeIssueScreenshots(
            normalizedIssue.attachments,
            options.artifactsDir,
            recorder,
        );
        const localScreenshotUrls = new Set(
            localIssueScreenshots.map((screenshot) => screenshot.issueScreenshotUrl),
        );
        const downloadedIssueScreenshots = await captureIssueScreenshots(
            facts.screenshots.filter((screenshot) => !localScreenshotUrls.has(screenshot.url)),
            { artifactsDir: options.artifactsDir, recorder, logger },
        );
        const preloadedIssueScreenshots = [...localIssueScreenshots, ...downloadedIssueScreenshots];
        const issueAttachmentArtifactIds = recorder
            .getArtifacts()
            .filter((artifact) => artifact.type === 'issue-screenshot')
            .map((artifact) => artifact.id);
        runtime = await AgentRuntime.create(
            {
                issue: normalizedIssue.rawIssue,
                issueFacts: facts,
                issueAttachmentArtifactIds,
                allowedTargetUrls,
                artifactsDir: options.artifactsDir,
                filtersPath: config.repositoryPath,
                headless: true,
                noSandbox: config.noSandbox,
                vision: visionClient,
                recorder,
                preparedExtension,
                // The run instruction and its model inputs ride the runtime too: every
                // between-phases rule application performs this instruction's application contract
                // through the bounded application sessions.
                instruction: options.instruction,
                llm: config.llm,
                piRuntime,
                // The run's one collector also meters the bounded application sessions, so their
                // tokens land in the same usage summary and run record as every other session.
                usageCollector: dependencies.usageCollector,
                // One dispatch, two branches: an instruction source replaces the KnowledgeBase
                // behind lookup_rule_guidance for the whole run.
                knowledgeGuidanceSource: resolveRuleGuidanceSource(options),
                preloadedIssueScreenshots,
                verbose: options.verbose,
                diagnosticsDir: config.diagnosticsDir,
                phaseReadinessBudgetMs: config.phaseReadinessBudgetMs,
                agentRuntimeExecutors: options.agentRuntime.executors,
                executorDependencies: options.agentRuntime.executorDependencies,
            },
            { ...dependencies.agentRuntime },
        );

        const run = await runFixSession({
            piRuntime,
            runtime,
            recorder,
            facts,
            issueNumber,
            routingCheck: options.routingCheck === true,
            llm: config.llm,
            budgets: {
                // The agentic investigation is bounded by wall clock, not turn count: a live route
                // spends many cheap turns on evidence, and a turn budget cut runs off mid-analysis.
                // The turn limit stays only as a runaway backstop far above any real investigation.
                wallClockMs: options.maxDurationMs ?? AGENTIC_INVESTIGATION_BUDGET_MS,
                maxTurns: options.maxIterations ?? AGENTIC_ITERATION_BACKSTOP,
            },
            workDir: options.artifactsDir,
            signal: options.signal,
            logger,
            instruction: options.instruction,
            usageCollector: dependencies.usageCollector,
        });
        dependencies.onAgentRunArtifacts?.({
            decision: run.terminalSource === FixTerminalSource.ModelFinishFix ? run.terminal : null,
            observations: run.observations,
        });
        const tracePath = persistTrace(run.trace, options.artifactsDir);
        const missingInformation = collectMissingInformation(run.observations);
        logMissingInformation(logger, missingInformation);
        const terminal = run.terminal;
        let terminalValidationEnvironment: AgentRuntimeEnvironmentEvidence | undefined;
        if (terminal.outcome === FixOutcomeKind.DraftPr) {
            const validationArtifactId = `validation-${createHash('sha256')
                .update(terminal.ruleProposal.rule)
                .digest('hex')
                .slice(0, 12)}`;
            terminalValidationEnvironment = runtime.getValidationEnvironment(validationArtifactId);
        }
        const candidateSafety = enforceCandidateSafety(terminal, {
            reportedDomain: terminalValidationEnvironment
                ? new URL(terminalValidationEnvironment.targetUrl).hostname
                : domain,
            checkoutPath: config.repositoryPath,
            problemType: facts.problemType,
        });
        const outcome = candidateSafety.outcome;
        const proposedCandidate = candidatePatchFromOutcome(outcome, config.repositoryPath);
        // The rule an analysis-only run found and could not verify. It has no publication path by
        // design; carrying it typed is what stops it from surviving only inside the reasoning
        // prose, where the sarkisozleri.bbs.tr run left the rule a maintainer later landed.
        const candidateForReview =
            outcome.outcome === FixOutcomeKind.AnalysisOnly
                ? outcome.candidateForReview
                : undefined;
        if (candidateForReview !== undefined) {
            logger.info(
                {
                    rule: candidateForReview.rule,
                    filePath: candidateForReview.placement?.filePath,
                    unverifiedReason: candidateForReview.unverifiedReason,
                },
                'analysis-only run carries an unverified candidate for review',
            );
        }
        const artifacts = recorder.getArtifacts();
        const selectedValidation = selectCandidateValidation(artifacts, proposedCandidate);
        const validationEnvironment = selectedValidation?.validationArtifactId
            ? runtime.getValidationEnvironment(selectedValidation.validationArtifactId)
            : undefined;
        const runtimeCandidateBinding = selectedValidation?.validationArtifactId
            ? runtime.getVerifiedCandidateBinding(selectedValidation.validationArtifactId)
            : undefined;
        const verifiedCandidateEnvironment = runtimeCandidateBinding?.environment;
        const trustedValidationContext = createTrustedValidationContext(
            validationEnvironment?.targetUrl ?? reportedUrl,
            config.repositoryPath,
        );
        browserState.usable = runtime.hasBrowserEvidence();
        browserState.effectiveMode = browserState.usable
            ? EffectiveMode.Browser
            : EffectiveMode.Reasoning;
        const lastBrowserError = runtime.getLastBrowserError();
        if (!browserState.usable && lastBrowserError) {
            browserState.fallbackReason = lastBrowserError.fallbackReason;
            browserState.fallbackDetail = lastBrowserError.detail;
        }
        // A challenge-walled target keeps the browser usable — the interstitial itself was
        // captured as evidence — so the unusable-browser mapping above never fires. The
        // exhausted per-target budget still names why the reported page stayed unverifiable;
        // surface it so the accepted analysis-only decision carries the typed target status
        // instead of a free-text explanation only.
        const exhaustedTargetFailure = runtime.getExhaustedTechnicalBrowserFailure();
        if (
            browserState.usable &&
            browserState.fallbackReason === null &&
            outcome.outcome === FixOutcomeKind.AnalysisOnly &&
            exhaustedTargetFailure !== undefined &&
            isTargetEnvironmentFallbackReason(exhaustedTargetFailure.fallbackReason)
        ) {
            browserState.fallbackReason = exhaustedTargetFailure.fallbackReason;
            browserState.fallbackDetail = exhaustedTargetFailure.detail;
        }
        const { candidatePatch, candidateVerified, verifiedScreenshots } = resolveCandidateVerdict({
            proposedCandidate,
            selectedValidation,
            trace: run.trace,
            artifacts,
            trustedValidationContext,
            browserUsable: browserState.usable,
            // An agentic candidate is only verified when it is bound to the exact browser session
            // that proved it, and only when that whole binding — not the screenshots alone —
            // serializes into the published evidence.
            boundToVerifiedEnvironment: verifiedCandidateEnvironment !== undefined,
            completeCandidateEvidence: (screenshots) =>
                serializeVerifiedCandidateBinding(
                    runtimeCandidateBinding,
                    selectedValidation,
                    screenshots,
                ) !== undefined,
        });
        const candidateValidationEvidence = serializeVerifiedCandidateBinding(
            runtimeCandidateBinding,
            selectedValidation,
            verifiedScreenshots,
        );
        if (runtimeCandidateBinding !== undefined && candidateValidationEvidence === undefined) {
            // The experiment already proved this candidate; losing it here silently would leave
            // the run reporting no patch with nothing to explain why.
            recordPreflightDiagnostic('run', {
                note: 'verified_candidate_binding_not_serialized',
                failures: describeVerifiedCandidateBindingFailure(
                    runtimeCandidateBinding,
                    selectedValidation,
                    verifiedScreenshots,
                ).slice(0, 12),
            });
        }
        // The one line that says how a terminal proposal became, or failed to become, a candidate
        // patch: a live run accepted a draft-PR terminal over a verified review and still ended
        // analysis-only with nothing in the log naming the step that dropped it.
        logger.info(
            {
                outcome: outcome.outcome,
                proposedRule: proposedCandidate?.rule,
                validationArtifactId: selectedValidation?.validationArtifactId,
                boundToVerifiedEnvironment: verifiedCandidateEnvironment !== undefined,
                candidateVerified,
                candidateValidationEvidence: candidateValidationEvidence !== undefined,
                browserUsable: browserState.usable,
                candidatePatch: candidatePatch !== null,
            },
            'candidate verdict resolved',
        );
        const noPatchDecision =
            outcome.outcome === FixOutcomeKind.ResolveWithoutPatch ||
            (outcome.outcome === FixOutcomeKind.ProposeClose &&
                outcome.reproductionStatus === 'not_reproduced');
        const completedEnvironments = runtime.getCompletedEnvironments();
        const completeVisionEnvironments = completedEnvironments.filter(
            (environment) => environment.navigationVerified && environment.fullVisionVerified,
        );
        const configurationEnvironmentMatrix =
            outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
            outcome.runStatus === FixRunStatus.ConfigurationSpecific
                ? selectConfigurationSpecificEnvironmentMatrix(completedEnvironments)
                : undefined;
        const noPatchEnvironment = noPatchDecision
            ? (configurationEnvironmentMatrix?.reporter ??
              runtime.getLatestCompleteVisionEnvironment())
            : undefined;
        let alreadyFixedEvidenceComplete = true;
        if (
            outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
            outcome.runStatus === FixRunStatus.AlreadyFixedCurrent
        ) {
            const hasControl = completeVisionEnvironments.some(
                (environment) => environment.extensionMode === ExtensionMode.None,
            );
            // The run's one host-prepared extension is the current pinned build by construction;
            // any verified-settings prepared session qualifies.
            const hasPreparedExtension = completeVisionEnvironments.some(
                (environment) =>
                    environment.extensionMode === ExtensionMode.Prepared &&
                    environment.settingsEvidence !== undefined,
            );
            alreadyFixedEvidenceComplete = hasControl && hasPreparedExtension;
        }
        const configurationEvidenceComplete =
            outcome.outcome === FixOutcomeKind.ResolveWithoutPatch &&
            outcome.runStatus === FixRunStatus.ConfigurationSpecific
                ? configurationEnvironmentMatrix !== undefined
                : true;
        const noPatchEvidenceComplete =
            !noPatchDecision ||
            (noPatchEnvironment !== undefined &&
                alreadyFixedEvidenceComplete &&
                configurationEvidenceComplete);
        const symptomObservation = noPatchEvidenceComplete
            ? outcome.outcome === FixOutcomeKind.ResolveWithoutPatch
                ? configurationEnvironmentMatrix
                    ? 'reproduced'
                    : runtime.getTerminalSymptomObservation()
                : symptomFromTerminal(outcome)
            : 'indeterminate';
        const derivedStatus = deriveFixRunStatus(
            outcome,
            candidatePatch,
            browserState.usable,
            symptomObservation,
        );
        runtime.bindPreparedExtensionActualContextForResult();
        const environmentSelection = runtime.getEnvironmentSelection();
        const agentTerminationReason = run.terminationReason ?? undefined;
        // A rejected terminal is NOT a failed run: the rejection was corrective guidance the
        // session could not act on, and mapping it to failed discarded complete analyses. The
        // host's analysis_only terminal (carrying the model's reasoning plus the rejection
        // summary) flows through the ordinary status mapping instead (owner decisions
        // 2026-08-18 / 2026-08-23, carried over unchanged from the legacy finish retry).
        // Every other host termination without an accepted model decision remains failed.
        const runStatus: FixRunStatus =
            environmentSelectionRunStatus(environmentSelection) ??
            (agentTerminationReason !== undefined && !run.terminalRejected
                ? 'failed'
                : !browserState.usable && lastBrowserError
                  ? isTargetEnvironmentFallbackReason(browserState.fallbackReason)
                      ? 'target_url_unavailable'
                      : 'browser_unavailable'
                  : browserState.usable &&
                      outcome.outcome === FixOutcomeKind.AnalysisOnly &&
                      isTargetEnvironmentFallbackReason(browserState.fallbackReason)
                    ? 'target_url_unavailable'
                    : derivedStatus);
        const boundEnvironment =
            validationEnvironment ?? noPatchEnvironment ?? runtime.getLatestEnvironment();
        if (boundEnvironment) {
            resultContext.domain = new URL(boundEnvironment.targetUrl).hostname;
        }
        const settingsEnvironment =
            boundEnvironment?.extension && boundEnvironment.settingsEvidence
                ? boundEnvironment
                : runtime.getLatestVerifiedSettingsEnvironment();
        const settingsEvidence = settingsEnvironment?.settingsEvidence;
        if (settingsEvidence) {
            // A file-backed read-back observes neither the enabled set nor the Stealth state; the
            // detail says "not observed" instead of reporting an empty set or a false boolean.
            const enabledFilters =
                settingsEvidence.enabledFilterIds === null
                    ? `the enabled filter set is ${NOT_OBSERVED_TEXT}`
                    : `${settingsEvidence.enabledFilterIds.length} enabled filters`;
            const stealthState =
                settingsEvidence.stealthEnabled === null
                    ? NOT_OBSERVED_TEXT
                    : settingsEvidence.stealthEnabled
                      ? '1'
                      : '0';
            resultContext.reproductionSettingsStatus = ReproductionSettingsStatus.Applied;
            resultContext.reproductionSettingsDetail =
                `The model selected profile ${settingsEvidence.profileKind}; the host read-back ` +
                `proved ${enabledFilters} and stealth.enabled=${stealthState}.`;
        } else if (facts.settingsImportUrl || facts.enabledFilters.length > 0) {
            resultContext.reproductionSettingsStatus = ReproductionSettingsStatus.ParsedNotApplied;
            resultContext.reproductionSettingsDetail =
                'The issue contains reporter settings, but the model did not produce a verified ' +
                'extension settings profile.';
        }
        const verificationStatus = deriveAgenticVerificationStatus(
            browserState.usable,
            candidateVerified,
            runStatus,
            noPatchEvidenceComplete,
        );
        const preferredRejectedValidationArtifactId =
            outcome.outcome === FixOutcomeKind.AnalysisOnly
                ? outcome.rejectedCandidateValidationArtifactId
                : undefined;
        let rejectedCandidateScreenshots: ReturnType<
            typeof selectRepresentativeRejectedCandidateScreenshots
        >;
        if (
            browserState.usable &&
            !candidateVerified &&
            (outcome.outcome === FixOutcomeKind.AnalysisOnly || proposedCandidate !== null)
        ) {
            rejectedCandidateScreenshots = selectRepresentativeRejectedCandidateScreenshots(
                artifacts,
                trustedValidationContext,
                preferredRejectedValidationArtifactId,
            );
        }
        const settingsProofPath = settingsEvidence
            ? persistAgentSettingsProof(settingsEvidence, options.artifactsDir, recorder)
            : undefined;
        const activeSession = runtime.getActiveBrowserSession();
        const candidateRejected = proposedCandidate !== null && candidatePatch === null;
        let reasoning = outcome.reasoning;
        if (candidateRejected) {
            reasoning =
                `${outcome.reasoning}\n\nCandidate omitted: the bound full-page vision review ` +
                'did not verify this exact rule, or its before/after evidence was incomplete.';
        } else if (noPatchDecision && !noPatchEvidenceComplete) {
            reasoning =
                `${outcome.reasoning}\n\nNo-patch status omitted: the selected browser session ` +
                'did not produce complete full-page vision evidence.';
        }
        let infrastructureFailureReason: InfrastructureFailureReason | undefined;
        if (runStatus !== 'unsupported_product_case' && runStatus !== 'capability_limited') {
            if (run.terminationReason === AgentTerminationReason.LlmError) {
                infrastructureFailureReason = InfrastructureFailureReason.LlmUnavailable;
            } else if (run.terminationReason === AgentTerminationReason.LlmRejected) {
                infrastructureFailureReason = InfrastructureFailureReason.LlmRejected;
            } else if (
                !browserState.usable &&
                lastBrowserError !== undefined &&
                !isTargetEnvironmentFallbackReason(browserState.fallbackReason)
            ) {
                infrastructureFailureReason = InfrastructureFailureReason.BrowserUnavailable;
            }
        }
        const baseResult = assembleFixRunResult({
            context: resultContext,
            runStatus,
            browserState,
            verificationStatus,
            reasoning,
            symptomObservation,
            currentRulesResolutionStatus: CurrentRulesResolutionStatus.NotAttempted,
            infrastructureFailureReason,
            // An environment-selection status (unsupported/capability-limited) outranks the loop
            // termination reason, and the schema binds the reason to failed runs only.
            agentTerminationReason: runStatus === 'failed' ? agentTerminationReason : undefined,
            artifacts,
            candidatePatch,
            candidateVerified,
            verifiedScreenshots,
            selectedValidation,
            rejectedCandidateScreenshots,
            visualReviewFromVerifiedCandidate: candidateVerified,
            tracePath,
            missingInformation: missingInformation.entries,
            browserLogPath: activeSession
                ? persistBrowserLog(activeSession, options.artifactsDir)
                : null,
            settingsProofPath: settingsProofPath ?? null,
        });
        const preparedExtensionProvenance = settingsEnvironment?.extension;
        const browserSessions = serializeAgentBrowserSessions(completedEnvironments);
        const finalResult: FixRunResult = {
            ...baseResult,
            browserSessions,
        };
        if (configurationEnvironmentMatrix) {
            finalResult.configurationComparisonEvidence =
                serializeConfigurationSpecificEnvironmentMatrix(configurationEnvironmentMatrix);
        }
        if (environmentSelection) {
            finalResult.environmentSelection = environmentSelection;
        }
        if (candidatePatch && candidateVerified && candidateValidationEvidence) {
            finalResult.candidateValidationEvidence = candidateValidationEvidence;
        }
        // The analysis-only candidate travels only while the run publishes no patch, which is the
        // schema invariant too. `assembleFixRunResult` clears `candidatePatch` on every status but
        // patch_proposed, so the guard reads the assembled result rather than the verdict.
        if (candidateForReview !== undefined && finalResult.candidatePatch === null) {
            finalResult.candidateForReview = candidateForReview;
        }
        if (preparedExtensionProvenance) {
            finalResult.extensionProvenance = serializeAgentExtensionProvenance(
                preparedExtensionProvenance,
            );
        }
        if (settingsEvidence) {
            finalResult.settingsEvidence = serializeAgentSettingsEvidence(settingsEvidence);
        }
        provisionalResult = finalResult;
    } catch (error) {
        recorder.record(TraceEventType.Error, {
            phase: 'agent_runtime',
            message: (error as Error).message,
        });
        const tracePath = persistTrace(recorder.end('failed'), options.artifactsDir);
        const failedResult = makeCoreResult(
            resultContext,
            'failed',
            browserState,
            'unavailable',
            `Agent runtime failed: ${(error as Error).message}`,
            null,
            emptyArtifactPaths(tracePath),
            'indeterminate',
        );
        const environmentSelection = runtime?.getEnvironmentSelection();
        provisionalResult = environmentSelection
            ? { ...failedResult, environmentSelection }
            : failedResult;
        failureDisposition = {
            status: 'failed',
            candidateDigest: null,
            failure: {
                code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                stage: EnvironmentLimitationStage.Phase,
                detail: 'The common filtering investigation did not complete.',
            },
        };
    }
    if (!provisionalResult) {
        throw new Error('The agent runtime did not produce a provisional result.');
    }
    const environmentLifecycle =
        runtime?.getFilteringEnvironmentLifecycle() ?? dependencies.environmentLifecycle;
    try {
        let finalResult = provisionalResult;
        if (environmentLifecycle) {
            finalResult = await completeFixResultAfterEnvironmentCleanup(provisionalResult, {
                ...environmentLifecycle,
                disposition:
                    failureDisposition ??
                    acceptedCandidateDisposition(provisionalResult) ??
                    environmentLifecycle.disposition,
                onProjectionRefused: (refusal) => {
                    recordPreflightDiagnostic('run', {
                        note: 'environment_projection_refused',
                        refusal,
                        runStatus: provisionalResult.runStatus,
                        candidatePatch: provisionalResult.candidatePatch !== null,
                        sessions: provisionalResult.browserSessions?.length ?? 0,
                    });
                },
            });
        }
        // The verdict was derived from the agent runtime's own sessions, but the evidence list
        // above was just replaced by canonical environment execution, which records only sessions
        // it conducted as phases. When that swap leaves no session proving a no-patch verdict, the
        // record would claim more than it holds: lower the claim rather than fail the run, which
        // is what a schema rejection here costs (de.euronews.com #238829, 2026-08-22).
        if (!noPatchVerdictIsSessionBound(finalResult)) {
            recordPreflightDiagnostic('run', {
                note: 'no_patch_verification_unbound',
                runStatus: finalResult.runStatus,
                sessionCount: finalResult.browserSessions?.length ?? 0,
                provenSessionCount:
                    finalResult.browserSessions?.filter(
                        (session) => session.navigationVerified && session.fullVisionVerified,
                    ).length ?? 0,
            });
            finalResult = { ...finalResult, verificationStatus: VerificationStatus.Partial };
        }
        const parsed = v.safeParse(FixRunResultSchema, finalResult);
        if (!parsed.success) {
            // The schema collapse loses the failing shape entirely; keep the exact issues and
            // the shape-relevant fields where a failed run can be diagnosed from one attempt.
            recordPreflightDiagnostic('run', {
                note: 'fix_run_result_schema_rejected',
                issues: parsed.issues.map((validationIssue) => validationIssue.message).slice(0, 8),
                runStatus: finalResult.runStatus,
                sessions: finalResult.browserSessions?.map((session) => ({
                    sessionId: session.sessionId,
                    extensionMode: session.extensionMode,
                    navigationVerified: session.navigationVerified,
                    hasExtension: session.extensionProvenance !== undefined,
                    hasSettings: session.settingsEvidence !== undefined,
                })),
                binding: finalResult.candidateValidationEvidence
                    ? {
                          sessionId: finalResult.candidateValidationEvidence.sessionId,
                          hasCli: finalResult.candidateValidationEvidence.cli !== undefined,
                          hasExtension:
                              finalResult.candidateValidationEvidence.extensionProvenance !==
                              undefined,
                      }
                    : null,
                topLevel: {
                    hasSettings: finalResult.settingsEvidence !== undefined,
                    hasExtensionProvenance: finalResult.extensionProvenance !== undefined,
                    visualVerdict: finalResult.candidateVisualReview?.verdict ?? null,
                },
            });
        }
        if (!parsed.success) {
            // Fail closed, but with an identity: an anonymous ValiError here was classified as
            // generic runtime infrastructure and cost a full evidence-archive reproduction to
            // attribute (2026-08-10). The violation is in this run's own result assembly.
            throw new FixRunResultContractError(
                parsed.issues.map((validationIssue) => validationIssue.message),
            );
        }
        return v.parse(FixRunResultSchema, finalResult);
    } finally {
        await runtime?.dispose();
        // An executor's evidence route that owns its own proxy process has no lifecycle to end it,
        // so the run stops it here on every path. Routes that register no stop are unaffected.
        await runtime?.stopEvidenceRoute();
    }
}

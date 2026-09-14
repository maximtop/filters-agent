/**
 * The artifacts a fix run persists before and around the agent loop — the trace, the browser log —
 * and the empty and populated artifact-path records the terminal result carries.
 */
import { mkdirSync, writeFileSync as writeArtifactFileSynchronously } from 'node:fs';
import { join } from 'node:path';
import { type BrowserSession } from '../browser/browser-session';
import type { TraceRecorder } from '../tracer/trace-recorder';
import {
    CurrentRulesResolutionStatus,
    FixRunStatus,
    SymptomObservation,
    VerificationStatus,
    type CandidatePatch,
    type FixRunArtifactPaths,
    type FixRunResult,
} from '../types/fix-run-result';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import type { CandidateVisualReview } from '../types/candidate-visual-review';
import { type RunTrace } from '../types/trace';
import type { MissingInformationEntry } from '../types/missing-information';
import type { CoreBrowserState, CoreResultContext } from './fix-core-context';

/**
 * Create empty artifact paths for terminal results produced before browser capture.
 *
 * @param tracePath - Optional persisted trace path.
 * @returns Schema-compatible empty artifact paths.
 */
export function emptyArtifactPaths(tracePath: string | null = null): FixRunArtifactPaths {
    return {
        screenshots: [],
        domSnapshot: null,
        har: null,
        trace: tracePath,
        settingsProof: null,
    };
}

/**
 * Build a serializable terminal result without publication state.
 *
 * @param context - Stable run metadata.
 * @param runStatus - Product outcome of the investigation.
 * @param browserState - Effective browser state.
 * @param verificationStatus - Strength of browser verification.
 * @param reasoning - Human-readable terminal explanation.
 * @param candidatePatch - Exact validated candidate, when present.
 * @param artifactPaths - Runtime artifact paths.
 * @param symptomObservation - Browser observation of the issue-defined defect.
 * @param currentRulesResolutionStatus - Independent current-checkout Phase B resolution state.
 * @param candidateVisualReview - Runner-bound vision verdict for the final candidate.
 * @param infrastructureFailureReason - Explicit unavailable runtime dependency, when proven.
 * @param agentTerminationReason - Typed Host termination without an accepted model decision.
 * @param missingInformation - Capped missing-information records the run recorded, when any.
 * @returns A GitHub-independent fix result.
 */
export function makeCoreResult(
    context: CoreResultContext,
    runStatus: FixRunStatus,
    browserState: CoreBrowserState,
    verificationStatus: VerificationStatus,
    reasoning: string,
    candidatePatch: CandidatePatch | null = null,
    artifactPaths: FixRunArtifactPaths = emptyArtifactPaths(),
    symptomObservation: SymptomObservation = SymptomObservation.NotAttempted,
    currentRulesResolutionStatus: CurrentRulesResolutionStatus = CurrentRulesResolutionStatus.NotAttempted,
    candidateVisualReview?: CandidateVisualReview,
    infrastructureFailureReason?: InfrastructureFailureReason,
    agentTerminationReason?: AgentTerminationReason,
    missingInformation?: readonly MissingInformationEntry[],
): FixRunResult {
    return {
        issueNumber: context.issueNumber,
        domain: context.domain,
        runStatus,
        requestedBrowserMode: context.requestedBrowserMode,
        effectiveMode: browserState.effectiveMode,
        verificationStatus,
        reproductionSettingsStatus: context.reproductionSettingsStatus,
        reproductionSettingsDetail: context.reproductionSettingsDetail,
        symptomObservation,
        currentRulesResolutionStatus,
        fallbackReason: browserState.fallbackReason,
        fallbackDetail: browserState.fallbackDetail,
        ...(context.reporterSettings ? { reporterSettings: context.reporterSettings } : {}),
        ...(infrastructureFailureReason ? { infrastructureFailureReason } : {}),
        ...(agentTerminationReason ? { agentTerminationReason } : {}),
        candidatePatch,
        ...(missingInformation !== undefined && missingInformation.length > 0
            ? { missingInformation: [...missingInformation] }
            : {}),
        ...(candidateVisualReview ? { candidateVisualReview } : {}),
        artifactPaths,
        reasoning,
        repository: context.repository,
        baseSha: context.baseSha,
        filtersRepository: context.filtersRepository,
        filtersBaseSha: context.filtersBaseSha,
    };
}

/**
 * Persist a trace under the caller-owned local artifact directory.
 *
 * @param trace - Trace snapshot to persist.
 * @param artifactsDir - Local output directory.
 * @returns Absolute or caller-resolved trace path.
 */
export function persistTrace(trace: RunTrace, artifactsDir: string): string {
    mkdirSync(artifactsDir, { recursive: true });
    const tracePath = join(artifactsDir, `trace-${trace.runId}.json`);
    writeArtifactFileSynchronously(tracePath, JSON.stringify(trace, null, 2));
    return tracePath;
}

/**
 * Persist bounded browser console messages as a runner-owned diagnostic artifact.
 *
 * @param session - Active browser session with its accumulated console log.
 * @param artifactsDir - Local output directory.
 * @returns Persisted browser-log path.
 */
export function persistBrowserLog(session: BrowserSession, artifactsDir: string): string {
    mkdirSync(artifactsDir, { recursive: true });
    const browserLogPath = join(artifactsDir, 'browser-console.json');
    const serialized = JSON.stringify(session.getConsoleLog(), null, 2);
    writeArtifactFileSynchronously(browserLogPath, serialized);
    return browserLogPath;
}

/**
 * Collect evidence paths for a terminal decision made before the reasoning loop.
 *
 * @param recorder - Artifact registry populated by browser preflight and vision.
 * @param tracePath - Persisted trace path.
 * @param settingsProofPath - Optional verified extension settings proof.
 * @param symptomEvidencePath - Optional typed live symptom comparison.
 * @param session - Active browser session used to persist bounded console diagnostics.
 * @param artifactsDir - Per-run local artifact directory.
 * @param visualInventoryPath - Optional pre-candidate full-page vision inventory.
 * @returns Complete browser evidence paths for the early terminal result.
 */
export function preAgentArtifactPaths(
    recorder: TraceRecorder,
    tracePath: string,
    symptomEvidencePath: string | undefined,
    session: BrowserSession,
    artifactsDir: string,
    visualInventoryPath?: string,
): FixRunArtifactPaths {
    const artifacts = recorder.getArtifacts();
    return {
        screenshots: artifacts
            .filter((artifact) =>
                [
                    'screenshot',
                    'screenshot-full-page',
                    'screenshot-tile',
                    'issue-screenshot',
                ].includes(artifact.type),
            )
            .map((artifact) => artifact.path),
        domSnapshot: artifacts.find((artifact) => artifact.type === 'dom')?.path ?? null,
        har: artifacts.find((artifact) => artifact.type === 'har')?.path ?? null,
        trace: tracePath,
        // The old driver published a pre-agent settings proof at launch; with the options-page
        // driver retired (11-HITL Decision 2) no pre-agent settings artifact exists. The run's
        // settings fact is the instruction application's host read-back, projected downstream.
        settingsProof: null,
        browserLog: persistBrowserLog(session, artifactsDir),
        symptomObservationEvidence: symptomEvidencePath ?? null,
        preCandidateVisualInventory: visualInventoryPath ?? null,
    };
}

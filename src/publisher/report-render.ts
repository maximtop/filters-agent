/**
 * Report rendering of the Publisher.
 *
 * One run outcome is turned into the fixed fill record every report template renders against (see
 * `report-template.ts`), with model-authored text escaped, flattened to one line, and bounded by
 * the shared untrusted-text machinery (see `untrusted-text.ts`) so a verbose or hostile run can
 * never break the comment structure. Comment bodies on GitHub sanitize most HTML, but the escape is
 * defense in depth: one reader-dependent renderer decides what `{{tokens}}` in a template become.
 * The `rule` fill is repository content rather than model prose, and renders through the same
 * module's inline-code-span renderer instead: Markdown reads a rule's own syntax (`*.../*`, say) as
 * formatting unless the whole value stays inside a code span.
 */

import {
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../environment/extension-preparation';
import type { PreparedExtensionProvenance } from '../environment/environment-proofs';
import {
    extractPlaceholders,
    PromptRenderError,
    PromptRenderErrorKind,
    renderTemplate,
} from '../prompts/template';
import { removeEmptySections } from './report-empty-sections';
import type { PolicyDecision } from '../types/policy';
import { AgentTerminationReason } from '../types/agent-termination-reason';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';
import { FixRunStatus, SymptomObservation } from '../types/fix-run-result';
import { InfrastructureFailureReason } from '../types/infrastructure-failure-reason';
import type { MissingInformationEntry } from '../types/missing-information';
import { renderVersionUpdateHint } from './report-version-decision';
import type { ReportTemplateValues } from './report-template';
import { renderUntrustedRuleCodeSpan, renderUntrustedText } from './untrusted-text';

/**
 * Label identifying the report comment in template-render errors.
 *
 * A stable label, not the prompt-document defaults: a comment body that fails to render must be
 * traceable to the publisher without looking like a prompt failure.
 */
const REPORT_COMMENT_SOURCE_LABEL = 'report comment template';

/**
 * Human labels for every run status, in the fixed `FixRunStatus` vocabulary. Total over
 * `FIX_RUN_STATUS_VALUES` by type: a new status fails this record until its label lands, so no
 * outcome can post an unfinished report.
 */
const RUN_STATUS_OUTCOME_LABELS: Record<FixRunStatus, string> = {
    [FixRunStatus.AlreadyFixedCurrent]: 'Already fixed in the current build',
    [FixRunStatus.FixedUpstreamPendingExtension]: 'Fixed upstream, pending the extension release',
    [FixRunStatus.FixedInSourcePendingPublication]:
        'Fixed in the filter source, pending publication',
    [FixRunStatus.PatchProposed]: 'Candidate rule proposed',
    [FixRunStatus.NotReproduced]: 'The reported defect was not reproduced',
    [FixRunStatus.ConfigurationSpecific]: 'The defect depends on reporter-specific configuration',
    [FixRunStatus.AnalysisOnly]: 'Analysis-only findings, no verified change',
    [FixRunStatus.UnsupportedProductCase]: 'Unsupported reported product case',
    [FixRunStatus.CapabilityLimited]: 'Missing environment capability limited the run',
    [FixRunStatus.TargetUrlUnavailable]: 'The reported target URL was unreachable',
    [FixRunStatus.BrowserUnavailable]: 'No usable browser was available',
    [FixRunStatus.CleanupFailed]: 'Environment cleanup did not complete',
    [FixRunStatus.Failed]: 'The run failed',
};

/**
 * Human labels for every browser fallback reason, total per type for the same drift guard.
 */
const FALLBACK_REASON_LABELS: Record<BrowserFallbackReason, string> = {
    [BrowserFallbackReason.LaunchFailed]: 'Browser launch failed',
    [BrowserFallbackReason.NavigationTimeout]: 'Navigation timed out',
    [BrowserFallbackReason.TargetUnreachable]: 'The page host was unreachable',
    [BrowserFallbackReason.NotFound]: 'The page returned not found',
    [BrowserFallbackReason.HttpBlocked]: 'The page refused to load in the run browser',
    [BrowserFallbackReason.BotChallenge]: 'A bot challenge blocked the page',
    [BrowserFallbackReason.GeoBlocked]: 'Regional restriction blocked the page',
    [BrowserFallbackReason.EmptyDom]: 'The page returned no usable document',
    [BrowserFallbackReason.NavigationOffOrigin]: 'Navigation left the issue origin',
    [BrowserFallbackReason.UnsafeTargetUrl]: 'The target URL is not openable in the run',
    [BrowserFallbackReason.TargetDnsUnresolved]: 'DNS lookup for the page failed',
    [BrowserFallbackReason.ArtifactCaptureFailed]: 'A required capture could not be taken',
    [BrowserFallbackReason.ExtensionConfigurationFailed]:
        'The extension under test could not be configured',
};

/**
 * Human labels for every infrastructure failure reason, total per type.
 */
const INFRASTRUCTURE_FAILURE_LABELS: Record<InfrastructureFailureReason, string> = {
    [InfrastructureFailureReason.InputUnavailable]: 'The issue snapshot could not be read',
    [InfrastructureFailureReason.EnvironmentUnavailable]:
        'The locked execution environment could not be prepared',
    [InfrastructureFailureReason.BrowserUnavailable]:
        'The browser stack failed before the target was exercised',
    [InfrastructureFailureReason.LlmUnavailable]: 'The reasoning provider was unreachable',
    [InfrastructureFailureReason.LlmRejected]: 'The reasoning provider rejected the run request',
    [InfrastructureFailureReason.VisionProviderUnavailable]: 'The vision provider was unavailable',
    [InfrastructureFailureReason.OutputUnavailable]: 'The run result could not be persisted',
    [InfrastructureFailureReason.FileBackedApplicationUnsupported]:
        'The run instruction requires file-backed blocker verification, which is not supported yet',
};

/**
 * Human labels for every agent termination reason, total per type.
 */
const AGENT_TERMINATION_LABELS: Record<AgentTerminationReason, string> = {
    [AgentTerminationReason.LlmError]: 'The provider request failed after retries',
    [AgentTerminationReason.LlmRejected]: 'The provider rejected the exact request',
    [AgentTerminationReason.TerminalNotCalled]: 'The agent loop ended without a terminal decision',
    [AgentTerminationReason.RetryBudgetExhausted]: 'A tool exhausted its failure budget',
    [AgentTerminationReason.MaxIterationsExceeded]: 'The agent loop reached its iteration limit',
    [AgentTerminationReason.RequestDeadlineExceeded]:
        'A provider response stalled past the per-request deadline',
    [AgentTerminationReason.WallClockExceeded]:
        'The investigation ran out of its wall-clock budget',
    [AgentTerminationReason.Interrupted]: 'The host aborted the run',
    [AgentTerminationReason.HaltedByCaller]: 'The caller halted the run',
    [AgentTerminationReason.CliInstallationCapabilityUnavailable]:
        'The CLI capability could not be transferred',
    [AgentTerminationReason.CliEnvironmentSelectionUnavailable]:
        'The CLI environment selection could not be retained',
    [AgentTerminationReason.CleanupObligationUnavailable]:
        'Durable cleanup recovery could not be armed',
};

/**
 * Human labels for every symptom observation, total per type.
 */
const SYMPTOM_OBSERVATION_LABELS: Record<SymptomObservation, string> = {
    [SymptomObservation.Reproduced]: 'Reproduced',
    [SymptomObservation.NotReproduced]: 'Not reproduced',
    [SymptomObservation.Indeterminate]: 'Indeterminate',
    [SymptomObservation.NotAttempted]: 'Not attempted',
};

/**
 * Human labels for every prepared-extension provenance source, total per type.
 */
const PREPARED_EXTENSION_SOURCE_LABELS: Record<PreparedExtensionSource, string> = {
    [PreparedExtensionSource.PinnedRelease]: 'Pinned prebuilt release',
    [PreparedExtensionSource.Preloaded]: 'Preloaded unpacked extension',
    [PreparedExtensionSource.Instruction]: 'Prepared from the instruction',
};

/**
 * The unverified candidate an analysis-only run hands to a reviewer, as the report reads it.
 */
export interface ReportCandidateForReview {
    /**
     * The filter rule the run found and could not verify.
     */
    rule: string;

    /**
     * The filter file the rule would belong in, when the run resolved one.
     */
    placement?: {
        /**
         * Checkout-relative filter file path.
         */
        filePath: string;
    };

    /**
     * Why validation did not confirm the rule.
     */
    unverifiedReason: string;
}

/**
 * The verified candidate fields the report shows, narrow so tests pass plain partial shapes.
 */
export interface ReportCandidatePatch {
    /**
     * The filter rule as proposed.
     */
    rule: string;

    /**
     * The filter file the rule lands in — the agreed "place in the list" reading.
     */
    filePath: string;
}

/**
 * The verified run-result fields the outcome summary reads, kept narrow so the publisher never
 * depends on incidental `FixRunResult` invariants — the assembled result is assignable as a whole,
 * while publisher tests pass plain partial shapes.
 */
export interface ReportRunResultInput {
    /**
     * Terminal status of the run.
     */
    runStatus: FixRunStatus;

    /**
     * Why a browser phase produced no conclusive observation, or null when none applies.
     */
    fallbackReason?: BrowserFallbackReason | null;

    /**
     * Host detail for the fallback, or null when the run carries none.
     */
    fallbackDetail?: string | null;

    /**
     * Why one of our own boundaries failed, when the run ended in infrastructure failure.
     */
    infrastructureFailureReason?: InfrastructureFailureReason;

    /**
     * Why the agent loop ended without an accepted model decision, when it did.
     */
    agentTerminationReason?: AgentTerminationReason;

    /**
     * Browser observation of the exact defect, when one was attempted.
     */
    symptomObservation?: SymptomObservation;

    /**
     * The proposed candidate and the filter file it lands in, or null when none was proposed.
     */
    candidatePatch?: ReportCandidatePatch | null;

    /**
     * The candidate an analysis-only run found and could not verify, when it carried one.
     */
    candidateForReview?: ReportCandidateForReview;

    /**
     * Provenance of the one extension build the run loaded, when it ran the prepared extension.
     */
    extensionProvenance?: PreparedExtensionProvenance;

    /**
     * The run's environment-selection snapshot, narrowed to the one field the version-update hint
     * compares against: the observed product version, a dotted-numeric manifest `version` (e.g.
     * `4.6.0`) — distinct from `extensionProvenance`'s tag-or-manifest-generation display value
     * (`v5.5.2.3`, `MV3`), which a version comparison can never parse.
     */
    environmentSelection?: {
        /**
         * The environment actually bound for the run, or null while unresolved.
         */
        actual: {
            /**
             * The observed product's manifest version, or null when unobserved.
             */
            productVersion: string | null;
        } | null;
    };

    /**
     * What the run instruction lacked, when the agent reported gaps.
     */
    missingInformation?: MissingInformationEntry[];
}

/**
 * The model-authored decision fields the outcome summary reads, narrow over `FixOutcome` variants.
 */
export interface ReportDecisionInput {
    /**
     * Model summary of the run for a human reviewer, when the decision carried one.
     */
    summary?: string;

    /**
     * Model reasoning behind the outcome, when the variant carries it.
     */
    reasoning?: string;

    /**
     * Deterministic policy verdict with its reasons, when the variant carries one.
     */
    policyDecision?: PolicyDecision;
}

/**
 * The outcome-level fields one report render is built from, before escaping.
 */
export interface ReportOutcomeSummary {
    /**
     * Outcome line for the run, from the total run-status label map.
     */
    outcome: string;

    /**
     * Why the run ended as it did — infrastructure failure, agent termination, or fallback detail.
     */
    outcomeReason: string;

    /**
     * Fixed one-line version-update hint, empty when the run outcome carries no update suggestion.
     */
    versionUpdateHint: string;

    /**
     * Symptom observation combined with the model summary, when the run observed the defect.
     */
    symptom: string;

    /**
     * The candidate rule as proposed, or the empty string when none was proposed.
     */
    rule: string;

    /**
     * The unverified candidate an analysis-only run asks a reviewer to look at, absent when the run
     * carried none.
     */
    candidateForReview?: ReportCandidateForReview;

    /**
     * The filter file the rule lands in — the agreed "place in the list" reading.
     */
    listPlace: string;

    /**
     * The run's executor: the source of the prepared extension build, or the empty string.
     */
    executor: string;

    /**
     * The executor version: the provenance tag, or the manifest generation.
     */
    executorVersion: string;

    /**
     * Deterministic policy rationale: policy reasons, else the decision reasoning.
     */
    policyRationale: string;

    /**
     * Gaps in the run instruction, exactly as reported.
     */
    missingInformation: MissingInformationEntry[];

    /**
     * Link to the run artifacts, provided by the caller.
     */
    artifactsLink: string;
}

/**
 * Compose the outcome reason from the verified failure fields, in a fixed order.
 *
 * @param result - Verified run-result fields under projection.
 * @returns Semicolon-joined reason text, or the empty string when the run carries no failure
 *   reason.
 */
function composeOutcomeReason(result: ReportRunResultInput): string {
    const pieces: string[] = [];
    if (result.infrastructureFailureReason !== undefined) {
        pieces.push(
            `Infrastructure failure: ${INFRASTRUCTURE_FAILURE_LABELS[result.infrastructureFailureReason]}`,
        );
    }
    if (result.agentTerminationReason !== undefined) {
        pieces.push(
            `Agent loop ended — ${AGENT_TERMINATION_LABELS[result.agentTerminationReason]}`,
        );
    }
    if (result.fallbackReason !== null && result.fallbackReason !== undefined) {
        const detail = (result.fallbackDetail ?? '').trim();
        pieces.push(
            `Fallback — ${FALLBACK_REASON_LABELS[result.fallbackReason]}${detail.length > 0 ? `: ${detail}` : ''}`,
        );
    }
    return pieces.join('; ');
}

/**
 * Render one missing-information record as a bounded block line.
 *
 * @param entry - The record as reported by the run.
 * @returns The `- subject: detail` line with both halves escaped and bounded.
 */
function renderMissingInformationLine(entry: MissingInformationEntry): string {
    return `- ${renderUntrustedText(entry.subject)}: ${renderUntrustedText(entry.detail)}`;
}

/**
 * Render the unverified candidate as the block its report section carries.
 *
 * The rule goes through the same code-span renderer the verified rule fill uses — it is repository
 * content whose own syntax Markdown would otherwise read as formatting — while the placement path
 * and the model-authored reason are escaped as untrusted text. The empty string when the run
 * carried no such candidate is what lets the section drop out of the rendered body entirely.
 *
 * @param candidate - The candidate the run could not verify, or undefined when it carried none.
 * @returns The block to fill the section with, or the empty string.
 */
function composeCandidateForReview(candidate: ReportCandidateForReview | undefined): string {
    if (candidate === undefined) {
        return '';
    }
    const lines = [renderUntrustedRuleCodeSpan(candidate.rule)];
    if (candidate.placement !== undefined) {
        lines.push('', renderUntrustedText(candidate.placement.filePath));
    }
    lines.push('', `Not verified: ${renderUntrustedText(candidate.unverifiedReason)}`);
    return lines.join('\n');
}

/**
 * Combine the symptom observation with the model-authored summary.
 *
 * @param result - Verified run-result fields under projection.
 * @param decision - Model-authored decision fields under projection.
 * @returns The combined symptom text, or the empty string when neither half exists.
 */
function composeSymptom(result: ReportRunResultInput, decision: ReportDecisionInput): string {
    const observation =
        result.symptomObservation === undefined
            ? ''
            : SYMPTOM_OBSERVATION_LABELS[result.symptomObservation];
    const authored = (decision.summary ?? '').trim();
    return [observation, authored].filter((half) => half.length > 0).join(' — ');
}

/**
 * Compose the policy rationale: deterministic policy reasons when the decision carries them, else
 * the model-authored reasoning.
 *
 * @param decision - Model-authored decision fields under projection.
 * @returns The rationale text, or the empty string when neither source exists.
 */
function composePolicyRationale(decision: ReportDecisionInput): string {
    const reasons = decision.policyDecision?.reasons ?? [];
    if (reasons.length > 0) {
        return reasons.join('; ');
    }
    return (decision.reasoning ?? '').trim();
}

/**
 * Compose the executor version: the provenance source tag when it exists, else the manifest
 * generation spelled as a version string.
 *
 * @param provenance - Prepared-extension provenance, or undefined when the run ran no extension.
 * @returns The version text, or the empty string when the run carried no provenance or its build
 *   records no manifest generation (a Firefox signed XPI, whose manifest the host never reads).
 */
function composeExecutorVersion(provenance: PreparedExtensionProvenance | undefined): string {
    if (provenance === undefined) {
        return '';
    }
    if (provenance.extensionSourceTag !== undefined) {
        return provenance.extensionSourceTag;
    }
    if (provenance.manifestVersion === undefined) {
        return '';
    }
    return provenance.manifestVersion === ExtensionManifestVersion.Mv3 ? 'MV3' : 'MV2';
}

/**
 * Project one run outcome into the narrow summary a report render is built from.
 *
 * @param result - Verified run-result fields under projection; a complete `FixRunResult` is
 *   assignable, and tests pass plain partial shapes.
 * @param decision - Model-authored decision fields under projection; a complete `FixOutcome` is
 *   assignable.
 * @param artifactsLink - Link to the run artifacts, provided by the caller that owns artifact URLs.
 * @param reportedVersion - The blocker version the report declares, verbatim from `Report` →
 *   `environment.version`, when the run carried the intake extraction.
 * @returns The outcome summary with raw text — escaping happens at fill-build time.
 */
export function summarizeReportOutcome(
    result: ReportRunResultInput,
    decision: ReportDecisionInput,
    artifactsLink: string,
    reportedVersion?: string,
): ReportOutcomeSummary {
    const executorVersion = composeExecutorVersion(result.extensionProvenance);
    return {
        outcome: RUN_STATUS_OUTCOME_LABELS[result.runStatus],
        outcomeReason: composeOutcomeReason(result),
        versionUpdateHint: renderVersionUpdateHint({
            reportedVersion,
            // Compared against the manifest's own dotted-numeric version, not the display
            // `executorVersion` above: a pinned release's tag (`v5.5.2.3`) or the bare `MV3`/`MV2`
            // label never parses as a version, so the hint could never fire against it.
            currentExecutorVersion:
                result.environmentSelection?.actual?.productVersion ?? undefined,
            symptomObservation: result.symptomObservation,
        }),
        symptom: composeSymptom(result, decision),
        rule: result.candidatePatch?.rule ?? '',
        ...(result.candidateForReview === undefined
            ? {}
            : { candidateForReview: result.candidateForReview }),
        listPlace: result.candidatePatch?.filePath ?? '',
        executor:
            result.extensionProvenance === undefined
                ? ''
                : PREPARED_EXTENSION_SOURCE_LABELS[result.extensionProvenance.source],
        executorVersion,
        policyRationale: composePolicyRationale(decision),
        missingInformation: result.missingInformation ?? [],
        artifactsLink,
    };
}

/**
 * Build one report render's fill values from the projected outcome.
 *
 * Every fill is computed — model-adjacent text goes through the bounded untrusted renderer, while
 * host-owned fields (outcome labels, artifact links, repository paths) pass through as written.
 *
 * @param summary - Projected outcome summary.
 * @returns Fill values covering every key of `REPORT_TEMPLATE_FILL`.
 */
export function buildReportTemplateValues(summary: ReportOutcomeSummary): ReportTemplateValues {
    return {
        outcome: summary.outcome,
        outcomeReason: renderUntrustedText(summary.outcomeReason),
        versionUpdateHint: renderUntrustedText(summary.versionUpdateHint),
        symptom: renderUntrustedText(summary.symptom),
        rule: renderUntrustedRuleCodeSpan(summary.rule),
        candidateForReview: composeCandidateForReview(summary.candidateForReview),
        executor: summary.executor,
        executorVersion: summary.executorVersion,
        policyRationale: renderUntrustedText(summary.policyRationale),
        listPlace: summary.listPlace,
        artifactsLink: summary.artifactsLink,
        missingInformation: (summary.missingInformation ?? [])
            .map(renderMissingInformationLine)
            .join('\n'),
    };
}

/**
 * Render one report comment body from a resolved template and the computed fill values.
 *
 * Fills are filtered down to `extractPlaceholders(template)` first, so a custom template using any
 * subset of the fixed set renders fine and unused fills are ignored. A token outside the fixed set
 * throws named — no fill can ever appear for it, and the strict render would otherwise misreport
 * the unknown token as merely "not filled". Every section whose body renders blank is then omitted,
 * on every outcome: a heading with nothing under it promises the reader a rule, a rationale or an
 * artifact the report does not have. The outcome itself carries no heading and always stays.
 *
 * @param template - Report template text; the instruction section or the built-in template.
 * @param values - Fill values covering every key of `REPORT_TEMPLATE_FILL`.
 * @returns The rendered comment body.
 */
export function renderReportComment(template: string, values: ReportTemplateValues): string {
    const declares = extractPlaceholders(template, REPORT_COMMENT_SOURCE_LABEL);
    const fills: Record<string, string> = values;
    const outsideFillSet = declares.filter((name) => !Object.hasOwn(fills, name));
    if (outsideFillSet.length > 0) {
        throw new PromptRenderError(
            PromptRenderErrorKind.UnknownPlaceholder,
            `${REPORT_COMMENT_SOURCE_LABEL}: placeholder(s) ${outsideFillSet.join(', ')} outside the report fill set — ` +
                `the fill set spells only: ${Object.keys(fills).join(', ')}`,
        );
    }
    const subset: Record<string, string> = {};
    for (const name of declares) {
        subset[name] = fills[name] ?? '';
    }
    return removeEmptySections(renderTemplate(template, subset, REPORT_COMMENT_SOURCE_LABEL));
}

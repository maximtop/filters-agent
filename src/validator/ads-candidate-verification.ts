import * as v from 'valibot';
import {
    EnvironmentLimitationStage,
    type EnvironmentAdapterLimitation,
    type EnvironmentPhaseEvidence,
    type ValidatorPhaseCompletion,
} from '../environment/filtering-environment';
import {
    SafeInteractionRefusalReason,
    type SafeInteractionSummary,
} from '../environment/safe-interaction';
import type {
    AdditiveCandidateGate,
    AdditiveCandidateGateOutcome,
} from '../repo/additive-candidate-gate';
import type { ReviewCandidateOperation } from '../repo/repository-edit';
import type { CandidatePatch } from '../types/fix-run-result';
import {
    observedReporterSymptom,
    type AdsBaselineReproductionResult,
} from './ads-baseline-reproduction';
import {
    executeEnvironmentPhase,
    type AdsEnvironmentPhaseObservationInput,
    type EnvironmentPhaseExecutionConfig,
} from './phase-orchestrator';

/**
 * Finite disposition of one additive-candidate verification.
 */
export const AdsCandidateVerificationStatus = {
    /**
     * Phase C read a verdict, and the candidate removed the reported ad without breaking the page.
     */
    Verified: 'verified',

    /**
     * A static gate, phase C's execution, or its verdict refused the candidate.
     */
    Rejected: 'rejected',

    /**
     * The baseline never reproduced the reported target, so phase C was never spent.
     */
    NotEligible: 'not_eligible',

    /**
     * Phase C executed, but produced no readable verdict either way.
     */
    Inconclusive: 'inconclusive',
} as const;

/**
 * Every AdsCandidateVerificationStatus value, for schemas and exhaustive listings.
 */
export const ADS_CANDIDATE_VERIFICATION_STATUS_VALUES = Object.values(
    AdsCandidateVerificationStatus,
);

/**
 * Finite disposition of one additive-candidate verification.
 */
export type AdsCandidateVerificationStatus =
    (typeof AdsCandidateVerificationStatus)[keyof typeof AdsCandidateVerificationStatus];

export const AdsCandidateVerificationStatusSchema = v.picklist(
    ADS_CANDIDATE_VERIFICATION_STATUS_VALUES,
);

/**
 * One phase-C validator outcome plus the preparation it performed.
 */
export interface AdsCandidatePhaseObservation {
    /**
     * Complete validator-owned observation handed to the recorder unchanged.
     */
    completion: ValidatorPhaseCompletion;

    /**
     * SHA-256 over the bounded page preparation and interaction sequence this phase performed.
     */
    preparationDigest: string;

    /**
     * Summary of the bounded interaction sequence this phase performed, or absent when the phase
     * required no interaction.
     */
    interaction?: SafeInteractionSummary;
}

/**
 * Rejected-candidate evidence retained for every non-verified disposition.
 */
export interface RejectedAdditiveCandidate {
    /**
     * SHA-256 of the exact proposed rule.
     */
    candidateDigest: string;

    /**
     * Exact gate that refused the candidate, or null when the evidence was merely unreadable.
     */
    failedGate: AdditiveCandidateGate | null;

    /**
     * Locked exact operation when the static gates passed, else null.
     */
    operation: ReviewCandidateOperation | null;
}

/**
 * Inputs for one additive-candidate verification attempt.
 */
export interface AdsCandidateVerificationConfig extends Omit<
    EnvironmentPhaseExecutionConfig,
    'candidate' | 'observe'
> {
    /**
     * Completed A/B reproduction whose eligibility gates phase C.
     */
    reproduction: AdsBaselineReproductionResult;

    /**
     * Outcome of every static gate the candidate had to pass before a phase could be spent.
     */
    gate: AdditiveCandidateGateOutcome;

    /**
     * Collect browser facts and the preparation sequence for phase C.
     *
     * @param input - Common session plus exact phase proof.
     * @returns Validator outcome and the preparation digest behind it.
     */
    observe(input: AdsEnvironmentPhaseObservationInput): Promise<AdsCandidatePhaseObservation>;
}

/**
 * Outcome of one additive-candidate verification.
 */
export interface AdsCandidateVerificationResult {
    /**
     * Finite verification disposition.
     */
    status: AdsCandidateVerificationStatus;

    /**
     * Exact gate that refused the candidate, or null.
     */
    failedGate: AdditiveCandidateGate | null;

    /**
     * Recorder-owned evidence for phase C when it reached completion.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when phase C could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Rejected-candidate evidence retained for every non-verified disposition.
     */
    rejected: RejectedAdditiveCandidate | null;

    /**
     * Publishable patch; non-null for `verified` and nothing else.
     */
    verifiedPatch: CandidatePatch | null;
}

/**
 * What a candidate-phase observer reported beside its completion.
 */
export interface ObservedCandidatePhase {
    /**
     * Preparation digest the candidate phase reported, or null when it never observed.
     */
    preparationDigest: string | null;

    /**
     * Interaction summary the candidate phase reported, or null when it performed none.
     */
    interaction: SafeInteractionSummary | null;
}

/**
 * Decide whether one completed candidate phase produced evidence a verdict may be read from.
 *
 * This is the sole definition of that bar, so a verified candidate and a pending-publication claim
 * cannot be credited on different evidence. It judges only readability: whether the reported
 * symptom was there is decided by the caller from `observedReporterSymptom`.
 *
 * @param evidence - Recorder-owned evidence for the completed candidate phase.
 * @param observed - Preparation digest and interaction the observer reported.
 * @param baselinePreparationDigest - Digest the published baseline phase reported.
 * @param candidateDigest - Digest the phase must prove it executed.
 * @returns Whether a verdict may be read from this phase.
 */
export function candidatePhaseEvidenceReadable(
    evidence: EnvironmentPhaseEvidence,
    observed: ObservedCandidatePhase,
    baselinePreparationDigest: string | null,
    candidateDigest: string,
): boolean {
    const completion = evidence.completion;
    // A step the candidate refused because the candidate removed its target is not unread evidence:
    // it is the expected shape of a working fix. `pageUsable` carries the replay comparison that
    // decides whether the page still works, so this case is judged there rather than pre-empted
    // here.
    const replayEndedOnRemovedTarget =
        observed.interaction?.status === 'refused' &&
        observed.interaction.refusalReason === SafeInteractionRefusalReason.TargetUnavailable;
    // A refused or failed interaction is judged here rather than as a phase failure: a page the
    // run was never allowed to drive is unread evidence, not a candidate that failed to apply.
    return (
        completion.kind === 'observed' &&
        completion.navigationVerified &&
        completion.artifacts.some((artifact) => artifact.kind === 'screenshot') &&
        observed.preparationDigest === baselinePreparationDigest &&
        evidence.proof.candidateDigest === candidateDigest &&
        (observed.interaction === null ||
            observed.interaction.status === 'completed' ||
            replayEndedOnRemovedTarget)
    );
}

/**
 * Apply one gated additive candidate as phase C and decide whether it is verified.
 *
 * Phase C is opened only when the baseline reproduced the reported target and every static gate
 * passed, so no failed gate can spend a licensed phase or reach a verified patch.
 *
 * @param config - Locked adapter, recorder, target, reproduction, gate outcome, and observer.
 * @returns Finite verification status with its recorder-owned evidence and rejected evidence.
 */
export async function runAdsCandidateVerification(
    config: AdsCandidateVerificationConfig,
): Promise<AdsCandidateVerificationResult> {
    const gate = config.gate;
    const phases: EnvironmentPhaseEvidence[] = [];

    const observed: ObservedCandidatePhase = { preparationDigest: null, interaction: null };

    /**
     * Build the single finite outcome, deriving the publishable patch in exactly one place.
     *
     * @param status - Finite verification disposition.
     * @param failedGate - Exact gate that refused the candidate, or null.
     * @param limitation - Stable limitation when phase C could not be established or observed.
     * @returns Complete verification result.
     */
    const dispose = (
        status: AdsCandidateVerificationStatus,
        failedGate: AdditiveCandidateGate | null,
        limitation: EnvironmentAdapterLimitation | null,
    ): AdsCandidateVerificationResult => ({
        status,
        failedGate,
        phases,
        limitation,
        rejected:
            status === AdsCandidateVerificationStatus.Verified
                ? null
                : {
                      candidateDigest: gate.accepted
                          ? gate.candidate.candidateDigest
                          : gate.candidateDigest,
                      failedGate,
                      operation: gate.accepted ? gate.candidate.operation : null,
                  },
        verifiedPatch:
            status === AdsCandidateVerificationStatus.Verified && gate.accepted
                ? gate.candidate.patch
                : null,
    });

    // Both refusals precede the candidate phase: a report the baseline never reproduced and a
    // candidate a static gate already refused must not spend a licensed phase to learn nothing.
    if (!config.reproduction.candidateEligible) {
        return dispose(AdsCandidateVerificationStatus.NotEligible, null, null);
    }
    if (!gate.accepted) {
        return dispose(AdsCandidateVerificationStatus.Rejected, gate.failedGate, null);
    }

    const executed = await executeEnvironmentPhase(
        {
            runId: config.runId,
            experimentId: config.experimentId,
            adapter: config.adapter,
            recorder: config.recorder,
            targetUrl: config.targetUrl,
            candidate: { operation: 'add', rule: gate.candidate.rule },
            observe: async (input) => {
                const observation = await config.observe(input);
                observed.preparationDigest = observation.preparationDigest;
                observed.interaction = observation.interaction ?? null;
                return observation.completion;
            },
        },
        'C',
    );
    if (executed.evidence) {
        phases.push(executed.evidence);
    }
    if (!executed.completed) {
        // Cleanup-stage limitations are retained as they are: the recorder applies the final
        // cleanup precedence over the whole execution, and repeating it here would double-count it.
        return executed.limitation.stage === EnvironmentLimitationStage.Cleanup
            ? dispose(AdsCandidateVerificationStatus.Inconclusive, null, executed.limitation)
            : dispose(
                  AdsCandidateVerificationStatus.Rejected,
                  'candidate_application',
                  executed.limitation,
              );
    }

    const evidence = executed.evidence;
    const completion = evidence.completion;
    // The readable-evidence bar itself lives in one place, so a verified candidate and a
    // pending-publication claim are credited on the same evidence. The `kind` test repeated here is
    // what narrows the completion for the page-usability read below.
    if (
        completion.kind !== 'observed' ||
        !candidatePhaseEvidenceReadable(
            evidence,
            observed,
            config.reproduction.baselinePreparationDigest,
            gate.candidate.candidateDigest,
        )
    ) {
        return dispose(AdsCandidateVerificationStatus.Inconclusive, null, null);
    }

    const symptom = observedReporterSymptom(evidence);
    if (symptom === 'present') {
        return dispose(AdsCandidateVerificationStatus.Rejected, 'target_removal', null);
    }
    // A page the candidate broke is never a fix, even when the advertisement went with it.
    if (!completion.targetObservation.pageUsable) {
        return dispose(AdsCandidateVerificationStatus.Rejected, 'page_usability', null);
    }
    return symptom === 'absent'
        ? dispose(AdsCandidateVerificationStatus.Verified, null, null)
        : dispose(AdsCandidateVerificationStatus.Inconclusive, null, null);
}

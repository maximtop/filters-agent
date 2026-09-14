import * as v from 'valibot';
import type { AnnoyanceInteractionObserver } from '../environment/annoyance-observer';
import type { AnnoyanceTarget, InteractedPageUsability } from '../environment/annoyance-target';
import type { EnvironmentSelectionSnapshot } from '../environment/environment-selection';
import type { EnvironmentAdapterLimitation } from '../environment/filtering-environment';
import {
    normalizeSafeInteractionPlan,
    type NormalizedSafeInteractionPlan,
} from '../environment/safe-interaction';
import {
    AdditiveCandidateGate,
    type AdditiveCandidateGateOutcome,
} from '../repo/additive-candidate-gate';
import type { CandidatePatch } from '../types/fix-run-result';
import { PhaseLabel } from '../types/validation';
import {
    AdsBaselineReproductionStatus,
    runAdsBaselineReproduction,
    type AdsBaselineReproductionResult,
} from './ads-baseline-reproduction';
import {
    AdsCandidateVerificationStatus,
    runAdsCandidateVerification,
    type AdsCandidateVerificationResult,
} from './ads-candidate-verification';
import type { EnvironmentPhaseExecutionConfig } from './phase-orchestrator';

/**
 * Finite disposition of one interactive Annoyance investigation.
 */
export const AnnoyanceInvestigationStatus = {
    /**
     * The candidate removed the identified annoyance without regressing the page.
     */
    Verified: 'verified',

    /**
     * The candidate did not remove the identified annoyance, or a structural check found it still
     * present after verification.
     */
    Rejected: 'rejected',

    /**
     * The published baseline no longer reproduces the reported annoyance.
     */
    AlreadyFixedInPublishedBaseline: 'already_fixed_in_published_baseline',

    /**
     * A required capability was unavailable, so no phase could reach a verdict.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The investigation could not settle on a verdict from the evidence it collected.
     */
    Inconclusive: 'inconclusive',

    /**
     * The observed intent is not an Annoyance report, so this investigation never opened a phase.
     */
    NotEligible: 'not_eligible',
} as const;

/**
 * Every AnnoyanceInvestigationStatus value, for schemas and exhaustive listings.
 */
export const ANNOYANCE_INVESTIGATION_STATUS_VALUES = Object.values(AnnoyanceInvestigationStatus);

export const AnnoyanceInvestigationStatusSchema = v.picklist(ANNOYANCE_INVESTIGATION_STATUS_VALUES);

/**
 * AnnoyanceInvestigationStatus value.
 */
export type AnnoyanceInvestigationStatus =
    (typeof AnnoyanceInvestigationStatus)[keyof typeof AnnoyanceInvestigationStatus];

/**
 * Inputs for one interactive Annoyance investigation.
 */
export interface AnnoyanceInvestigationConfig extends Omit<
    EnvironmentPhaseExecutionConfig,
    'candidate' | 'observe'
> {
    /**
     * Locked environment selection carrying declared context and observed intent.
     */
    selection: EnvironmentSelectionSnapshot;

    /**
     * Untrusted agent-proposed interaction sequence.
     */
    interactionPlan: unknown;

    /**
     * Build the observer bound to the normalized plan.
     *
     * @param plan - Normalized plan every phase executes.
     * @returns Observer for this investigation.
     */
    observerFactory(plan: NormalizedSafeInteractionPlan): AnnoyanceInteractionObserver;

    /**
     * Outcome of every static gate the candidate must pass before phase C.
     */
    gate: AdditiveCandidateGateOutcome;
}

/**
 * Outcome of one interactive Annoyance investigation.
 */
export interface AnnoyanceInvestigationResult {
    /**
     * Finite Annoyance disposition.
     */
    status: AnnoyanceInvestigationStatus;

    /**
     * Declared issue context exactly as the report stated it.
     */
    declared: EnvironmentSelectionSnapshot['declared'];

    /**
     * Observed intent exactly as the collected evidence settled it.
     */
    observed: EnvironmentSelectionSnapshot['observed'];

    /**
     * Identity of the annoyance the published baseline revealed, else null.
     */
    target: AnnoyanceTarget | null;

    /**
     * Digest of the normalized sequence every phase replayed, else null.
     */
    interactionPlanDigest: string | null;

    /**
     * Usability of the interacted page under the candidate, else null.
     */
    usability: InteractedPageUsability | null;

    /**
     * Exact gate that refused the candidate, else null.
     */
    failedGate: AdditiveCandidateGate | null;

    /**
     * Completed A/B reproduction, or null when no phase was opened.
     */
    reproduction: AdsBaselineReproductionResult | null;

    /**
     * Completed candidate verification, or null when phase C was never reached.
     */
    verification: AdsCandidateVerificationResult | null;

    /**
     * Stable limitation when a phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Publishable patch; non-null for `verified` and nothing else.
     */
    verifiedPatch: CandidatePatch | null;
}

/**
 * Everything one disposition is built from once the run reaches its decision.
 */
interface AnnoyanceDispositionEvidence {
    /**
     * Digest of the normalized sequence, else null when nothing was normalized.
     */
    interactionPlanDigest: string | null;

    /**
     * Exact gate that refused the candidate, else null.
     */
    failedGate: AdditiveCandidateGate | null;

    /**
     * Completed A/B reproduction, else null.
     */
    reproduction: AdsBaselineReproductionResult | null;

    /**
     * Completed candidate verification, else null.
     */
    verification: AdsCandidateVerificationResult | null;

    /**
     * Observer that holds the recorded annoyance and the candidate observations, else null.
     */
    observer: AnnoyanceInteractionObserver | null;
}

/**
 * Decide how one non-reproduced baseline disposes the Annoyance investigation.
 *
 * A refusal is the host declining a capability the report requires; an infrastructure failure is a
 * run that could not see. Both withhold a candidate phase, and naming which one happened is what
 * makes the outcome actionable.
 *
 * @param reproduction - Completed A/B reproduction.
 * @param observer - Observer holding each phase's interaction summary.
 * @returns Finite disposition for a baseline that did not reproduce.
 */
function disposeBaseline(
    reproduction: AdsBaselineReproductionResult,
    observer: AnnoyanceInteractionObserver,
): AnnoyanceInvestigationStatus {
    if (reproduction.status === AdsBaselineReproductionStatus.AlreadyFixedInPublishedBaseline) {
        return reproduction.status;
    }
    if (reproduction.status === AdsBaselineReproductionStatus.AccessLimited) {
        return AnnoyanceInvestigationStatus.CapabilityLimited;
    }
    const refused = ([PhaseLabel.A, PhaseLabel.B] as const).some(
        (phase) => observer.interactionOf(phase)?.status === 'refused',
    );
    return refused
        ? AnnoyanceInvestigationStatus.CapabilityLimited
        : AnnoyanceInvestigationStatus.Inconclusive;
}

/**
 * Run one interactive Annoyance investigation from declared intent to candidate disposition.
 *
 * The structural target correlation runs after candidate verification and may only narrow its
 * verdict, never widen it, so a second definition of the symptom can never credit a patch.
 *
 * @param config - Locked adapter, recorder, target, selection, proposed plan, and gate.
 * @returns Finite Annoyance disposition with its evidence and, for exactly one status, a patch.
 */
export async function runAnnoyanceInvestigation(
    config: AnnoyanceInvestigationConfig,
): Promise<AnnoyanceInvestigationResult> {
    /**
     * Build the single finite outcome, deriving the publishable patch in exactly one place.
     *
     * @param status - Finite Annoyance disposition.
     * @param evidence - Everything the run collected before it decided.
     * @returns Complete investigation result.
     */
    const dispose = (
        status: AnnoyanceInvestigationStatus,
        evidence: AnnoyanceDispositionEvidence,
    ): AnnoyanceInvestigationResult => ({
        status,
        declared: config.selection.declared,
        observed: config.selection.observed,
        target: evidence.observer?.target() ?? null,
        interactionPlanDigest: evidence.interactionPlanDigest,
        usability: evidence.observer?.usability() ?? null,
        failedGate: evidence.failedGate,
        reproduction: evidence.reproduction,
        verification: evidence.verification,
        limitation: evidence.verification?.limitation ?? evidence.reproduction?.limitation ?? null,
        verifiedPatch:
            status === AnnoyanceInvestigationStatus.Verified && config.gate.accepted
                ? config.gate.candidate.patch
                : null,
    });

    const empty: AnnoyanceDispositionEvidence = {
        interactionPlanDigest: null,
        failedGate: null,
        reproduction: null,
        verification: null,
        observer: null,
    };

    // A run whose observed intent is not an Annoyance is not this investigation: nothing is
    // normalized and no licensed phase opens to learn what the evidence already settled.
    if (config.selection.observed.issueType !== 'annoyance') {
        return dispose(AnnoyanceInvestigationStatus.NotEligible, empty);
    }

    const normalized = normalizeSafeInteractionPlan(config.interactionPlan);
    if (normalized.kind !== 'normalized') {
        return dispose(AnnoyanceInvestigationStatus.CapabilityLimited, empty);
    }
    const plan = normalized.plan;
    const observer = config.observerFactory(plan);
    const base: AnnoyanceDispositionEvidence = {
        ...empty,
        interactionPlanDigest: plan.digest,
        observer,
    };

    const reproduction = await runAdsBaselineReproduction({
        runId: config.runId,
        experimentId: config.experimentId,
        adapter: config.adapter,
        recorder: config.recorder,
        targetUrl: config.targetUrl,
        observe: (input) => observer.observeBaseline(input),
    });
    const reproduced: AnnoyanceDispositionEvidence = { ...base, reproduction };
    if (reproduction.status !== 'reproduced') {
        return dispose(disposeBaseline(reproduction, observer), reproduced);
    }
    // A baseline that never reduced to one exact annoyance has nothing for the candidate phase to
    // prove gone, so the licensed phase is withheld rather than spent on an unnamed symptom.
    if (observer.target() === null) {
        return dispose(AnnoyanceInvestigationStatus.Inconclusive, reproduced);
    }

    const verification = await runAdsCandidateVerification({
        runId: config.runId,
        experimentId: config.experimentId,
        adapter: config.adapter,
        recorder: config.recorder,
        targetUrl: config.targetUrl,
        reproduction,
        gate: config.gate,
        observe: (input) => observer.observeCandidate(input),
    });
    const verified: AnnoyanceDispositionEvidence = {
        ...reproduced,
        verification,
        failedGate: verification.failedGate,
    };
    if (verification.status === AdsCandidateVerificationStatus.NotEligible) {
        return dispose(AnnoyanceInvestigationStatus.NotEligible, verified);
    }
    if (verification.status === AdsCandidateVerificationStatus.Rejected) {
        return dispose(AnnoyanceInvestigationStatus.Rejected, verified);
    }
    if (verification.status === AdsCandidateVerificationStatus.Inconclusive) {
        return dispose(
            observer.interactionOf(PhaseLabel.C)?.status === 'refused'
                ? AnnoyanceInvestigationStatus.CapabilityLimited
                : AnnoyanceInvestigationStatus.Inconclusive,
            verified,
        );
    }

    // The structural correlation is the last word and it only narrows: a surface that is still
    // there, or an identity that drifted, withholds the patch the vision path was ready to credit.
    const correlation = observer.correlation();
    if (correlation === 'absent') {
        return dispose(AnnoyanceInvestigationStatus.Verified, verified);
    }
    if (correlation === 'present') {
        return dispose(AnnoyanceInvestigationStatus.Rejected, {
            ...verified,
            failedGate: AdditiveCandidateGate.TargetRemoval,
        });
    }
    return dispose(AnnoyanceInvestigationStatus.Inconclusive, verified);
}

import * as v from 'valibot';
import type { BrowserPreflightEvidence } from '../analyzer/browser-first-run';
import type {
    EnvironmentAdapterLimitation,
    EnvironmentPhaseEvidence,
    ValidatorObservedPhaseCompletion,
    ValidatorPhaseCompletion,
} from '../environment/filtering-environment';
import type { EnvironmentPhase } from '../environment/environment-proofs';
import type { SafeInteractionSummary } from '../environment/safe-interaction';
import { classifyTargetAccess, TargetAccessClassification } from '../environment/target-access';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import {
    executeEnvironmentPhase,
    type AdsEnvironmentPhaseObservationInput,
    type EnvironmentPhaseExecutionConfig,
} from './phase-orchestrator';
import { PhaseLabel } from '../types/validation';

/**
 * Finite disposition of one A/B Ads reproduction.
 */
export const AdsBaselineReproductionStatus = {
    /**
     * The reported symptom was seen under the published baseline, with supporting image evidence.
     */
    Reproduced: 'reproduced',

    /**
     * The symptom was absent under the published baseline but present under the disabled control.
     */
    AlreadyFixedInPublishedBaseline: 'already_fixed_in_published_baseline',

    /**
     * The symptom was absent under both the published baseline and the disabled control.
     */
    TargetChanged: 'target_changed',

    /**
     * A phase's target could not be fully accessed.
     */
    AccessLimited: 'access_limited',

    /**
     * Neither reproduction nor its absence could be established from the available evidence.
     */
    Inconclusive: 'inconclusive',
} as const;

/**
 * Every AdsBaselineReproductionStatus value, for schemas and exhaustive listings.
 */
export const ADS_BASELINE_REPRODUCTION_STATUS_VALUES = Object.values(AdsBaselineReproductionStatus);

export const AdsBaselineReproductionStatusSchema = v.picklist(
    ADS_BASELINE_REPRODUCTION_STATUS_VALUES,
);

/**
 * AdsBaselineReproductionStatus value.
 */
export type AdsBaselineReproductionStatus =
    (typeof AdsBaselineReproductionStatus)[keyof typeof AdsBaselineReproductionStatus];

/**
 * One phase's validator outcome plus the raw page facts an access decision needs.
 */
export interface AdsBaselinePhaseObservation {
    /**
     * Complete validator-owned observation handed to the recorder unchanged.
     */
    completion: ValidatorPhaseCompletion;

    /**
     * Raw navigation, status, text and artifact facts for this phase.
     */
    access: BrowserPreflightEvidence;

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
 * Inputs for one A/B Ads reproduction attempt.
 */
export interface AdsBaselineReproductionConfig extends Omit<
    EnvironmentPhaseExecutionConfig,
    'candidate' | 'observe'
> {
    /**
     * Collect browser facts and page-access evidence for one adapter-established phase.
     *
     * @param input - Common session plus exact phase proof.
     * @returns Validator outcome and the raw page facts behind it.
     */
    observe(input: AdsEnvironmentPhaseObservationInput): Promise<AdsBaselinePhaseObservation>;
}

/**
 * Outcome of one A/B Ads reproduction before any candidate work.
 */
export interface AdsBaselineReproductionResult {
    /**
     * Finite reproduction disposition.
     */
    status: AdsBaselineReproductionStatus;

    /**
     * Access classification of the first phase that was not fully accessible, else `accessible`.
     */
    access: TargetAccessClassification;

    /**
     * Recorder-owned evidence for every phase that reached completion, in A then B order.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when a phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Whether candidate verification may proceed; true for `reproduced` and nothing else.
     */
    candidateEligible: boolean;

    /**
     * Preparation digest the published baseline phase reported, or null when it never completed.
     */
    baselinePreparationDigest: string | null;
}

/**
 * Read the vision-owned presence of the reported symptom from one phase's captures.
 *
 * The collapsed `targetObservation.symptomPresent` boolean is deliberately never consulted: it
 * reports an indeterminate vision result as present, which would let "the model could not tell"
 * become "the advertisement is there".
 *
 * @param completion - Complete validator observation for one phase.
 * @returns The presence every capture agrees on, else `indeterminate`.
 */
function observedSymptom(completion: ValidatorObservedPhaseCompletion): ReporterSymptomPresence {
    const captures = completion.captures ?? [];
    if (captures.length === 0) {
        return ReporterSymptomPresence.Indeterminate;
    }
    const presences = captures.map((capture) =>
        capture.visionVerified && capture.coverageComplete
            ? (capture.reporterSymptomPresence ?? ReporterSymptomPresence.Indeterminate)
            : ReporterSymptomPresence.Indeterminate,
    );
    const [first] = presences;
    return presences.every((presence) => presence === first)
        ? first!
        : ReporterSymptomPresence.Indeterminate;
}

/**
 * Read the presence of the reported symptom from one phase's canonical evidence.
 *
 * Exported so the baseline and the candidate phase are judged by exactly one definition of "the
 * reported symptom was seen".
 *
 * @param evidence - Recorder-owned evidence for one phase, when that phase completed.
 * @returns The presence the phase proved, else `indeterminate`.
 */
export function observedReporterSymptom(
    evidence: EnvironmentPhaseEvidence | undefined,
): ReporterSymptomPresence {
    if (!evidence || evidence.completion.kind !== 'observed') {
        return ReporterSymptomPresence.Indeterminate;
    }
    return observedSymptom(evidence.completion);
}

/**
 * Run the filtering-disabled control and the published baseline, then dispose the Ads reproduction.
 *
 * Runs A and B only. A candidate phase is never opened here: `candidateEligible` is the sole gate,
 * and it is true for exactly one status.
 *
 * @param config - Locked adapter, recorder, target, and browser observer.
 * @returns Finite reproduction status with its recorder-owned phase evidence.
 */
export async function runAdsBaselineReproduction(
    config: AdsBaselineReproductionConfig,
): Promise<AdsBaselineReproductionResult> {
    const phases: EnvironmentPhaseEvidence[] = [];
    const pageFacts = new Map<EnvironmentPhase, BrowserPreflightEvidence>();
    const preparationDigests = new Map<EnvironmentPhase, string>();
    const interactions = new Map<EnvironmentPhase, SafeInteractionSummary>();

    /**
     * Build the single finite outcome, deriving candidate eligibility in exactly one place.
     *
     * @param status - Finite reproduction disposition.
     * @param access - Access classification behind that disposition.
     * @param limitation - Stable limitation when a phase could not be established or observed.
     * @returns Complete reproduction result.
     */
    const dispose = (
        status: AdsBaselineReproductionStatus,
        access: TargetAccessClassification,
        limitation: EnvironmentAdapterLimitation | null,
    ): AdsBaselineReproductionResult => ({
        status,
        access,
        phases,
        limitation,
        candidateEligible: status === AdsBaselineReproductionStatus.Reproduced,
        baselinePreparationDigest: preparationDigests.get('B') ?? null,
    });

    const executionConfig: EnvironmentPhaseExecutionConfig = {
        runId: config.runId,
        experimentId: config.experimentId,
        adapter: config.adapter,
        recorder: config.recorder,
        targetUrl: config.targetUrl,
        candidate: null,
        observe: async (input) => {
            const observation = await config.observe(input);
            pageFacts.set(input.phase, observation.access);
            preparationDigests.set(input.phase, observation.preparationDigest);
            if (observation.interaction) {
                interactions.set(input.phase, observation.interaction);
            }
            return observation.completion;
        },
    };

    for (const phase of [PhaseLabel.A, PhaseLabel.B] as const) {
        const result = await executeEnvironmentPhase(executionConfig, phase);
        if (result.evidence) {
            phases.push(result.evidence);
        }
        // Cleanup-stage limitations are retained as they are: the recorder applies the final
        // cleanup precedence over the whole execution, and repeating it here would double-count it.
        if (!result.completed) {
            return dispose(
                AdsBaselineReproductionStatus.Inconclusive,
                TargetAccessClassification.Accessible,
                result.limitation,
            );
        }
        const facts = pageFacts.get(phase);
        const access = facts ? classifyTargetAccess(facts) : TargetAccessClassification.Accessible;
        // Decided before the next phase opens: a page the run cannot honestly reach is not worth
        // a second license-backed phase.
        if (access !== TargetAccessClassification.Accessible) {
            return dispose(AdsBaselineReproductionStatus.AccessLimited, access, null);
        }
        // A symptom that only appears after an interaction was never observed when that
        // interaction was refused, cut short, or failed, so the phase proves nothing either way.
        const interaction = interactions.get(phase);
        if (interaction && interaction.status !== 'completed') {
            return dispose(
                AdsBaselineReproductionStatus.Inconclusive,
                TargetAccessClassification.Accessible,
                null,
            );
        }
    }

    const baseline = phases.find((phase) => phase.phase === PhaseLabel.B);
    if (baseline?.completion.kind !== 'observed' || !baseline.completion.navigationVerified) {
        return dispose(
            AdsBaselineReproductionStatus.Inconclusive,
            TargetAccessClassification.Accessible,
            null,
        );
    }
    const symptomInBaseline = observedReporterSymptom(baseline);
    const symptomInControl = observedReporterSymptom(
        phases.find((phase) => phase.phase === PhaseLabel.A),
    );
    const baselineHasImage = baseline.completion.artifacts.some(
        (artifact) => artifact.kind === 'screenshot',
    );
    if (symptomInBaseline === ReporterSymptomPresence.Present && baselineHasImage) {
        return dispose(
            AdsBaselineReproductionStatus.Reproduced,
            TargetAccessClassification.Accessible,
            null,
        );
    }
    if (
        symptomInBaseline === ReporterSymptomPresence.Absent &&
        symptomInControl === ReporterSymptomPresence.Present
    ) {
        return dispose(
            AdsBaselineReproductionStatus.AlreadyFixedInPublishedBaseline,
            TargetAccessClassification.Accessible,
            null,
        );
    }
    // Absent on both sides means the page no longer exposes what was reported, which is a changed
    // target rather than a filter that fixed anything.
    if (
        symptomInBaseline === ReporterSymptomPresence.Absent &&
        symptomInControl === ReporterSymptomPresence.Absent
    ) {
        return dispose(
            AdsBaselineReproductionStatus.TargetChanged,
            TargetAccessClassification.Accessible,
            null,
        );
    }
    return dispose(
        AdsBaselineReproductionStatus.Inconclusive,
        TargetAccessClassification.Accessible,
        null,
    );
}

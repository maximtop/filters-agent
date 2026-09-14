import * as v from 'valibot';
import type { EnvironmentSelectionSnapshot } from '../environment/environment-selection';
import { classifyExpectedBehavior, ExpectedBehaviorState } from '../environment/expected-behavior';
import {
    assessFilteringInvariant,
    FilteringInvariantState,
    type FilteringEffectAssessment,
} from '../environment/filtering-effect';
import {
    CandidateOperation,
    type EnvironmentAdapterLimitation,
    type EnvironmentPhaseEvidence,
} from '../environment/filtering-environment';
import type { EnvironmentPhase } from '../environment/environment-proofs';
import {
    AdditiveCandidateGate,
    type AdditiveCandidateGateOutcome,
} from '../repo/additive-candidate-gate';
import { PhaseLabel } from '../types/validation';
import type { CandidatePatch } from '../types/fix-run-result';
import {
    observedReporterSymptom,
    type AdsBaselinePhaseObservation,
} from './ads-baseline-reproduction';
import type { RejectedAdditiveCandidate } from './ads-candidate-verification';
import {
    runIncorrectBlockingInvestigation,
    type IncorrectBlockingInvestigationResult,
    type IncorrectBlockingStatus,
} from './incorrect-blocking-investigation';
import {
    executeEnvironmentPhase,
    type AdsEnvironmentPhaseObservationInput,
    type EnvironmentPhaseExecutionConfig,
} from './phase-orchestrator';

/**
 * Finite disposition of one Incorrect Blocking repair attempt.
 */
export const IncorrectBlockingRepairStatus = {
    /**
     * The candidate exception restored expected behavior without regressing filtering.
     */
    Verified: 'verified',

    /**
     * The candidate was refused by a gate or failed to restore expected behavior.
     */
    Rejected: 'rejected',

    /**
     * The environment could not carry out this repair attempt.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The candidate phase could not prove or disprove a repair.
     */
    Inconclusive: 'inconclusive',

    /**
     * The isolation diagnosis named no filter this repair could act on.
     */
    NotEligible: 'not_eligible',
} as const;

/**
 * Every Incorrect Blocking repair status value, for schemas and exhaustive listings.
 */
export const INCORRECT_BLOCKING_REPAIR_STATUS_VALUES = Object.values(IncorrectBlockingRepairStatus);

/**
 * Incorrect Blocking repair status value.
 */
export type IncorrectBlockingRepairStatus =
    (typeof IncorrectBlockingRepairStatus)[keyof typeof IncorrectBlockingRepairStatus];

export const IncorrectBlockingRepairStatusSchema = v.picklist(
    INCORRECT_BLOCKING_REPAIR_STATUS_VALUES,
);

/**
 * One phase observation of an Incorrect Blocking repair, with its filtering witnesses.
 */
export interface IncorrectBlockingPhaseObservation extends AdsBaselinePhaseObservation {
    /**
     * Bounded witnesses of observable filtering effects this phase saw, or null when it saw none.
     */
    filteringWitness: readonly string[] | null;
}

/**
 * Inputs for one Incorrect Blocking repair attempt.
 */
export interface IncorrectBlockingRepairConfig extends Omit<
    EnvironmentPhaseExecutionConfig,
    'candidate' | 'observe' | 'enabledListKeys'
> {
    /**
     * Locked environment selection carrying declared context, observed intent, and the baseline.
     */
    selection: EnvironmentSelectionSnapshot;

    /**
     * Outcome of every static gate the exception had to pass before a phase could be spent.
     */
    gate: AdditiveCandidateGateOutcome;

    /**
     * Collect browser facts, page-access evidence, and filtering witnesses for one phase.
     *
     * @param input - Common session plus exact phase proof.
     * @returns Validator outcome and the raw page facts behind it.
     */
    observe(input: AdsEnvironmentPhaseObservationInput): Promise<IncorrectBlockingPhaseObservation>;
}

/**
 * Outcome of one Incorrect Blocking repair attempt.
 */
export interface IncorrectBlockingRepairResult {
    /**
     * Finite repair disposition.
     */
    status: IncorrectBlockingRepairStatus;

    /**
     * Complete isolation diagnosis this repair was built on.
     */
    investigation: IncorrectBlockingInvestigationResult;

    /**
     * Expected behaviour the candidate phase proved.
     */
    restored: ExpectedBehaviorState;

    /**
     * What the candidate phase proved about the baseline's observable filtering.
     */
    filtering: FilteringEffectAssessment;

    /**
     * Exact gate that refused the candidate, or null.
     */
    failedGate: AdditiveCandidateGate | null;

    /**
     * Rejected-candidate evidence retained for every non-verified disposition.
     */
    rejected: RejectedAdditiveCandidate | null;

    /**
     * Recorder-owned evidence for the candidate phase when it reached completion.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when the candidate phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Publishable patch; non-null for `verified` and nothing else.
     */
    verifiedPatch: CandidatePatch | null;
}

/**
 * Decide how one diagnosis that named no culprit disposes the repair.
 *
 * A run that was never this investigation, and one the environment could not carry out, describe
 * the run rather than the report, so both are reported unchanged. Every other withheld diagnosis is
 * a repair this run may not open; the exact diagnosis stays readable on the retained investigation
 * instead of being flattened into a second vocabulary.
 *
 * @param status - Finite diagnosis the isolation investigation reported.
 * @returns Finite repair disposition for a diagnosis that named no filter.
 */
function disposeWithheld(status: IncorrectBlockingStatus): IncorrectBlockingRepairStatus {
    return status === 'not_eligible' || status === 'capability_limited'
        ? status
        : IncorrectBlockingRepairStatus.Inconclusive;
}

/**
 * Repair one isolated Incorrect Blocking failure with a single additive exception.
 *
 * The candidate phase opens only after a filter was named and every static gate passed, and it is
 * credited only when the expected behaviour is restored, the filtering the reported baseline was
 * observably performing survives, and the page stays usable.
 *
 * @param config - Locked adapter, recorder, target, selection, gate outcome, and observer.
 * @returns Finite repair status with its evidence and, for exactly one status, a patch.
 */
export async function runIncorrectBlockingRepair(
    config: IncorrectBlockingRepairConfig,
): Promise<IncorrectBlockingRepairResult> {
    const gate = config.gate;
    const phases: EnvironmentPhaseEvidence[] = [];
    const firstObservations = new Map<EnvironmentPhase, IncorrectBlockingPhaseObservation>();
    let restored: ExpectedBehaviorState = ExpectedBehaviorState.Indeterminate;
    // Nothing has been observed yet, so the invariant reports the one state a run with no evidence
    // may claim, through the same derivation that decides it later.
    let filtering = assessFilteringInvariant({ control: null, baseline: null, candidate: null });

    /**
     * Build the single finite outcome, deriving the rejected evidence and the publishable patch in
     * exactly one place each.
     *
     * @param status - Finite repair disposition.
     * @param failedGate - Exact gate that refused the candidate, or null.
     * @param limitation - Stable limitation when the candidate phase could not be established.
     * @returns Complete repair result.
     */
    const dispose = (
        status: IncorrectBlockingRepairStatus,
        failedGate: AdditiveCandidateGate | null = null,
        limitation: EnvironmentAdapterLimitation | null = null,
    ): IncorrectBlockingRepairResult => ({
        status,
        investigation,
        restored,
        filtering,
        failedGate,
        rejected:
            status === IncorrectBlockingRepairStatus.Verified
                ? null
                : {
                      candidateDigest: gate.accepted
                          ? gate.candidate.candidateDigest
                          : gate.candidateDigest,
                      failedGate,
                      operation: gate.accepted ? gate.candidate.operation : null,
                  },
        phases,
        limitation,
        verifiedPatch:
            status === IncorrectBlockingRepairStatus.Verified && gate.accepted
                ? gate.candidate.patch
                : null,
    });

    /**
     * Observe one phase and retain the first observation that phase produced.
     *
     * The isolation run observes the control once and the reported baseline once, always before it
     * reuses phase B for the narrowed probes, so retaining the first observation of each phase is
     * what makes a narrowed probe impossible to read as the reported baseline.
     *
     * @param input - Common session plus the exact proof this phase was opened under.
     * @returns Everything the caller's observer reported for this phase.
     */
    const observeOnce = async (
        input: AdsEnvironmentPhaseObservationInput,
    ): Promise<IncorrectBlockingPhaseObservation> => {
        const observation = await config.observe(input);
        if (!firstObservations.has(input.phase)) {
            firstObservations.set(input.phase, observation);
        }
        return observation;
    };

    const investigation = await runIncorrectBlockingInvestigation({
        ...config,
        observe: observeOnce,
    });
    // Both refusals precede the candidate phase: a failure no filter was proven to control, and an
    // exception a static gate already refused, must not spend a licensed phase to learn nothing.
    if (!investigation.candidateEligible) {
        return dispose(disposeWithheld(investigation.status));
    }
    if (!gate.accepted) {
        return dispose(IncorrectBlockingRepairStatus.Rejected, gate.failedGate);
    }

    const executed = await executeEnvironmentPhase(
        {
            runId: config.runId,
            experimentId: config.experimentId,
            adapter: config.adapter,
            recorder: config.recorder,
            targetUrl: config.targetUrl,
            // The published culprit, not the operation kind, is what says "this candidate acts on
            // an exact published line": a constrained shared-rule extension also locks an `edit`
            // operation, yet the state its reported site executes is one added rule. Which of the
            // two published-line shapes it is, is then the locked operation's to say. A removal
            // sends the published line as `rule`, because that is the line the environment deletes
            // and the line its candidate digest is taken over.
            candidate:
                gate.candidate.publishedCulprit === undefined
                    ? { operation: CandidateOperation.Add, rule: gate.candidate.rule }
                    : gate.candidate.operation.operation === 'remove'
                      ? {
                            operation: CandidateOperation.Remove,
                            rule: gate.candidate.publishedCulprit,
                        }
                      : {
                            operation: CandidateOperation.Edit,
                            rule: gate.candidate.rule,
                            originalRule: gate.candidate.publishedCulprit,
                        },
            observe: async (input) => (await observeOnce(input)).completion,
        },
        'C',
    );
    if (executed.evidence) {
        phases.push(executed.evidence);
    }
    if (!executed.completed) {
        // Cleanup-stage limitations are retained as they are: the recorder applies the final
        // cleanup precedence over the whole execution, and repeating it here would double-count it.
        return executed.limitation.stage === 'cleanup'
            ? dispose(IncorrectBlockingRepairStatus.Inconclusive, null, executed.limitation)
            : dispose(
                  IncorrectBlockingRepairStatus.Rejected,
                  AdditiveCandidateGate.CandidateApplication,
                  executed.limitation,
              );
    }

    const evidence = executed.evidence;
    const completion = evidence.completion;
    const observed = firstObservations.get(PhaseLabel.C) ?? null;
    const baseline = firstObservations.get(PhaseLabel.B) ?? null;
    // A comparison the run cannot make is not a verdict. The other half of running the reported
    // baseline plus exactly this exception is the adapter's obligation and is proven there: the
    // candidate phase re-lists the catalog and requires the enabled set, the co-enabled set, and
    // the user-filter row to equal the baseline's before it emits a proof at all.
    if (
        completion.kind !== 'observed' ||
        !completion.navigationVerified ||
        !completion.artifacts.some((artifact) => artifact.kind === 'screenshot') ||
        observed === null ||
        baseline === null ||
        observed.preparationDigest !== baseline.preparationDigest ||
        evidence.proof.candidateDigest !== gate.candidate.candidateDigest
    ) {
        return dispose(IncorrectBlockingRepairStatus.Inconclusive);
    }

    restored = classifyExpectedBehavior({
        breakage: observedReporterSymptom(evidence),
        interaction: observed.interaction ?? null,
        control: firstObservations.get('A')?.interaction ?? null,
    });
    if (restored === ExpectedBehaviorState.Indeterminate) {
        return dispose(IncorrectBlockingRepairStatus.Inconclusive);
    }
    if (restored === ExpectedBehaviorState.Broken) {
        return dispose(
            IncorrectBlockingRepairStatus.Rejected,
            AdditiveCandidateGate.BehaviorRestoration,
        );
    }

    filtering = assessFilteringInvariant({
        control: firstObservations.get('A')?.filteringWitness ?? null,
        baseline: baseline.filteringWitness,
        candidate: observed.filteringWitness,
    });
    // An exception that bought the behaviour back by switching off filtering the reported baseline
    // was observably performing is not a repair, however well the page reads.
    if (filtering.state === FilteringInvariantState.Regressed) {
        return dispose(
            IncorrectBlockingRepairStatus.Rejected,
            AdditiveCandidateGate.FilteringRegression,
        );
    }

    if (!completion.targetObservation.pageUsable) {
        return dispose(IncorrectBlockingRepairStatus.Rejected, AdditiveCandidateGate.PageUsability);
    }
    return dispose(IncorrectBlockingRepairStatus.Verified);
}

import * as v from 'valibot';
import type { BrowserPreflightEvidence } from '../analyzer/browser-first-run';
import type { EnvironmentSelectionSnapshot } from '../environment/environment-selection';
import { classifyExpectedBehavior, ExpectedBehaviorState } from '../environment/expected-behavior';
import {
    type EnvironmentAdapterLimitation,
    type EnvironmentPhaseEvidence,
} from '../environment/filtering-environment';
import { provenEnabledListKeys, type EnvironmentPhase } from '../environment/environment-proofs';
import { sortListKeys } from '../environment/filter-list-ref';
import type { SkippedFilterSource } from '../environment/official-filter-catalog';
import type { SafeInteractionSummary } from '../environment/safe-interaction';
import { classifyTargetAccess, TargetAccessClassification } from '../environment/target-access';
import {
    observedReporterSymptom,
    type AdsBaselinePhaseObservation,
} from './ads-baseline-reproduction';
import {
    executeEnvironmentPhase,
    type AdsEnvironmentPhaseObservationInput,
    type EnvironmentPhaseExecutionConfig,
} from './phase-orchestrator';

/**
 * Finite disposition of one Incorrect Blocking investigation.
 */
export const IncorrectBlockingStatus = {
    /**
     * A leave-one-out sweep named exactly one official filter that controls the breakage.
     */
    Isolated: 'isolated',

    /**
     * The sweep completed but could not name a single controlling filter.
     */
    NotIsolated: 'not_isolated',

    /**
     * The reported baseline worked and the reporter also named sources this run never executed.
     */
    ConfigurationSpecific: 'configuration_specific',

    /**
     * A required environment phase could not be established or observed.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The control or baseline phase could not be classified either way.
     */
    Inconclusive: 'inconclusive',

    /**
     * The observed intent is not Incorrect Blocking, so no phase of this investigation opens.
     */
    NotEligible: 'not_eligible',
} as const;

/**
 * Every IncorrectBlockingStatus value, for schemas and exhaustive listings.
 */
export const INCORRECT_BLOCKING_STATUS_VALUES = Object.values(IncorrectBlockingStatus);

/**
 * IncorrectBlockingStatus value.
 */
export type IncorrectBlockingStatus =
    (typeof IncorrectBlockingStatus)[keyof typeof IncorrectBlockingStatus];

export const IncorrectBlockingStatusSchema = v.picklist(INCORRECT_BLOCKING_STATUS_VALUES);

/**
 * Largest reported official set this slice will sweep, in filters.
 *
 * Each probe is a licensed browser phase, so a leave-one-out sweep is bounded rather than
 * unlimited; a wider reported set reports `not_isolated` instead of spending the phases.
 */
export const MAX_ISOLATION_FILTERS = 8;

/**
 * One official list-key state the run tested inside the locked environment.
 */
export interface IsolationProbeEvidence {
    /**
     * Canonically sorted list keys this probe asked the environment to enable.
     */
    requestedListKeys: readonly string[];

    /**
     * Sorted list keys the phase proof actually proved enabled, or null when it never opened.
     */
    provenListKeys: readonly string[] | null;

    /**
     * Expected behaviour this toggle state observed.
     */
    behavior: ExpectedBehaviorState;

    /**
     * Recorder-owned evidence for this probe, or null when the phase never completed.
     */
    evidence: EnvironmentPhaseEvidence | null;
}

/**
 * Inputs for one Incorrect Blocking investigation.
 */
export interface IncorrectBlockingInvestigationConfig extends Omit<
    EnvironmentPhaseExecutionConfig,
    'candidate' | 'observe' | 'enabledListKeys'
> {
    /**
     * Locked environment selection carrying declared context, observed intent, and the baseline.
     */
    selection: EnvironmentSelectionSnapshot;

    /**
     * Collect browser facts and page-access evidence for one adapter-established phase.
     *
     * @param input - Common session plus exact phase proof.
     * @returns Validator outcome and the raw page facts behind it.
     */
    observe(input: AdsEnvironmentPhaseObservationInput): Promise<AdsBaselinePhaseObservation>;
}

/**
 * Outcome of one Incorrect Blocking investigation.
 */
export interface IncorrectBlockingInvestigationResult {
    /**
     * Finite Incorrect Blocking disposition.
     */
    status: IncorrectBlockingStatus;

    /**
     * Declared issue context exactly as the report stated it.
     */
    declared: EnvironmentSelectionSnapshot['declared'];

    /**
     * Observed intent exactly as the collected evidence settled it.
     */
    observed: EnvironmentSelectionSnapshot['observed'];

    /**
     * Expected behaviour the filtering-disabled control proved.
     */
    control: ExpectedBehaviorState;

    /**
     * Expected behaviour the reported official baseline proved.
     */
    baseline: ExpectedBehaviorState;

    /**
     * Sorted list keys the reported baseline is made of, else empty.
     */
    officialListKeys: readonly string[];

    /**
     * Official list key proven to control the breakage; non-null for `isolated` and nothing else.
     */
    culpritListKey: string | null;

    /**
     * Every toggle state the run tested, in the order it tested them.
     */
    probes: IsolationProbeEvidence[];

    /**
     * Reported filter sources this run recorded and never executed.
     */
    skippedSources: readonly SkippedFilterSource[];

    /**
     * Recorder-owned evidence for the control and the reported baseline, in A then B order.
     */
    phases: EnvironmentPhaseEvidence[];

    /**
     * Stable limitation when a phase could not be established or observed.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Whether an exception candidate may be proposed; true for `isolated` and nothing else.
     */
    candidateEligible: boolean;
}

/**
 * One finite diagnosis, with a named culprit for exactly the one status that may carry it.
 */
type IncorrectBlockingDiagnosis =
    | {
          /**
           * Discriminator for the only disposition that names a list.
           */
          status: typeof IncorrectBlockingStatus.Isolated;

          /**
           * Official list key whose enabled and disabled states control the breakage.
           */
          culpritListKey: string;
      }
    | {
          /**
           * Every disposition that withholds the handoff to candidate work.
           */
          status: Exclude<IncorrectBlockingStatus, typeof IncorrectBlockingStatus.Isolated>;

          /**
           * Never named: no list was proven to control the breakage.
           */
          culpritListKey?: never;
      };

/**
 * Everything one completed or refused phase reported back to the composition.
 */
interface PhaseOutcome {
    /**
     * Whether the phase was observed and closed without a limitation.
     */
    completed: boolean;

    /**
     * Recorder-owned evidence whenever observation reached the recorder, else null.
     */
    evidence: EnvironmentPhaseEvidence | null;

    /**
     * Stable limitation when the phase could not be established or observed, else null.
     */
    limitation: EnvironmentAdapterLimitation | null;

    /**
     * Raw page facts this phase observed, or null when it never reached observation.
     */
    access: BrowserPreflightEvidence | null;

    /**
     * Interaction summary this phase performed, or null when it required no interaction.
     */
    interaction: SafeInteractionSummary | null;
}

/**
 * One recorded isolation probe plus the reason it could not be established, when there was one.
 */
interface IsolationProbeOutcome {
    /**
     * The toggle state this probe tested, recorded whether or not it can be credited.
     */
    probe: IsolationProbeEvidence;

    /**
     * Stable limitation when the probe phase could not be established or observed, else null.
     */
    limitation: EnvironmentAdapterLimitation | null;
}

/**
 * Compare two list-key sets regardless of the order each side emitted them in.
 *
 * @param left - First key list.
 * @param right - Second key list.
 * @returns Whether both lists canonicalize to the same sorted members.
 */
function sameKeys(left: readonly string[], right: readonly string[]): boolean {
    const sortedLeft = sortListKeys(left);
    const sortedRight = sortListKeys(right);
    return (
        sortedLeft.length === sortedRight.length &&
        sortedLeft.every((key, index) => key === sortedRight[index])
    );
}

/**
 * Run one Incorrect Blocking investigation from the disabled control to a named culprit.
 *
 * The run proves the expected behaviour works without filtering and fails under the reported
 * official baseline before any filter is blamed, then toggles only reported official filters inside
 * the same locked environment to name the one that controls the failure.
 *
 * @param config - Locked adapter, recorder, target, selection, and browser observer.
 * @returns Finite diagnosis with every tested toggle state and, for exactly one status, a culprit.
 */
export async function runIncorrectBlockingInvestigation(
    config: IncorrectBlockingInvestigationConfig,
): Promise<IncorrectBlockingInvestigationResult> {
    const phases: EnvironmentPhaseEvidence[] = [];
    const probes: IsolationProbeEvidence[] = [];
    let officialListKeys: readonly string[] = [];
    let skippedSources: readonly SkippedFilterSource[] = [];
    let control: ExpectedBehaviorState = ExpectedBehaviorState.Indeterminate;
    let baseline: ExpectedBehaviorState = ExpectedBehaviorState.Indeterminate;

    /**
     * Build the single finite outcome, deriving the culprit and eligibility in exactly one place.
     *
     * @param diagnosis - Finite disposition and, for `isolated` alone, the list key it names.
     * @param limitation - Stable limitation when a phase could not be established or observed.
     * @returns Complete investigation result.
     */
    const dispose = (
        diagnosis: IncorrectBlockingDiagnosis,
        limitation: EnvironmentAdapterLimitation | null = null,
    ): IncorrectBlockingInvestigationResult => ({
        status: diagnosis.status,
        declared: config.selection.declared,
        observed: config.selection.observed,
        control,
        baseline,
        officialListKeys,
        culpritListKey: diagnosis.culpritListKey ?? null,
        probes,
        skippedSources,
        phases,
        limitation,
        candidateEligible: diagnosis.status === IncorrectBlockingStatus.Isolated,
    });

    /**
     * Open, observe, and close one phase of this investigation.
     *
     * Each probe runs under its own derived experiment identity because the recorder issues at most
     * one token per experiment and phase, while the adapter state — and so the environment identity
     * every proof carries — stays the one that was locked.
     *
     * @param phase - Exact phase to execute.
     * @param enabledListKeys - Official list-key subset for a narrowed baseline, else null.
     * @param experimentId - Identity this phase is recorded under.
     * @returns Evidence or limitation, plus the page facts the caller classifies.
     */
    const runPhase = async (
        phase: EnvironmentPhase,
        enabledListKeys: readonly string[] | null,
        experimentId: string,
    ): Promise<PhaseOutcome> => {
        let access: BrowserPreflightEvidence | null = null;
        let interaction: SafeInteractionSummary | null = null;
        const result = await executeEnvironmentPhase(
            {
                runId: config.runId,
                experimentId,
                adapter: config.adapter,
                recorder: config.recorder,
                targetUrl: config.targetUrl,
                candidate: null,
                enabledListKeys,
                observe: async (input) => {
                    const observation = await config.observe(input);
                    access = observation.access;
                    interaction = observation.interaction ?? null;
                    return observation.completion;
                },
            },
            phase,
        );
        return {
            completed: result.completed,
            evidence: result.evidence,
            limitation: result.completed ? null : result.limitation,
            access,
            interaction,
        };
    };

    // A run whose observed intent is not incorrect blocking is not this investigation: no licensed
    // phase opens to learn what the collected evidence already settled.
    if (config.selection.observed.issueType !== 'incorrect_blocking') {
        return dispose({ status: IncorrectBlockingStatus.NotEligible });
    }
    const filterBaseline = config.selection.filterBaseline;
    if (filterBaseline?.status !== 'executable') {
        return dispose({ status: IncorrectBlockingStatus.CapabilityLimited });
    }
    officialListKeys = filterBaseline.officialFilters.map((filter) => filter.listKey);
    skippedSources = filterBaseline.skippedSources;

    const controlPhase = await runPhase('A', null, config.experimentId);
    if (controlPhase.evidence) {
        phases.push(controlPhase.evidence);
    }
    if (!controlPhase.completed || !controlPhase.evidence) {
        return dispose(
            { status: IncorrectBlockingStatus.CapabilityLimited },
            controlPhase.limitation,
        );
    }
    const controlAccess = controlPhase.access;
    if (
        controlAccess &&
        classifyTargetAccess(controlAccess) !== TargetAccessClassification.Accessible
    ) {
        return dispose({ status: IncorrectBlockingStatus.CapabilityLimited });
    }
    const controlInteraction = controlPhase.interaction;
    control = classifyExpectedBehavior({
        breakage: observedReporterSymptom(controlPhase.evidence),
        interaction: controlInteraction,
        control: null,
    });
    // The withholding is the acceptance criterion: filtering is never blamed for a behaviour the
    // run did not first watch working without it, so no baseline phase opens.
    if (control !== ExpectedBehaviorState.Works) {
        return dispose({ status: IncorrectBlockingStatus.Inconclusive });
    }

    const baselinePhase = await runPhase('B', null, config.experimentId);
    if (baselinePhase.evidence) {
        phases.push(baselinePhase.evidence);
    }
    if (!baselinePhase.completed || !baselinePhase.evidence) {
        return dispose(
            { status: IncorrectBlockingStatus.CapabilityLimited },
            baselinePhase.limitation,
        );
    }
    baseline = classifyExpectedBehavior({
        breakage: observedReporterSymptom(baselinePhase.evidence),
        interaction: baselinePhase.interaction,
        control: controlInteraction,
    });
    if (baseline !== ExpectedBehaviorState.Broken) {
        // A baseline the run watched *working* proves the behaviour the report describes is not in
        // the official filters; when the report also named sources this run recorded and never
        // executed, that is a configuration this run cannot reproduce rather than a filter it
        // failed to find. A baseline the run could not classify proves neither, so it stays
        // inconclusive and points the engineer at the unreadable phase instead of at the
        // reporter's filter list.
        return dispose({
            status:
                baseline === ExpectedBehaviorState.Works && skippedSources.length > 0
                    ? IncorrectBlockingStatus.ConfigurationSpecific
                    : IncorrectBlockingStatus.Inconclusive,
        });
    }

    // A single reported list needs no probe at all: the control is already its disabled state and
    // the reported baseline is its enabled state.
    if (officialListKeys.length === 1) {
        return dispose({
            status: IncorrectBlockingStatus.Isolated,
            culpritListKey: officialListKeys[0]!,
        });
    }
    if (officialListKeys.length > MAX_ISOLATION_FILTERS) {
        return dispose({ status: IncorrectBlockingStatus.NotIsolated });
    }

    /**
     * Open one narrowed baseline and record what that exact official set observed.
     *
     * @param requestedListKeys - List-key subset this probe asks to enable.
     * @param label - Suffix distinguishing this probe's experiment identity.
     * @returns The recorded probe, or the limitation that stopped it.
     */
    const runProbe = async (
        requestedListKeys: readonly string[],
        label: string,
    ): Promise<IsolationProbeOutcome> => {
        const outcome = await runPhase(
            'B',
            requestedListKeys,
            `${config.experimentId}:isolation:${label}`,
        );
        const evidence = outcome.completed ? outcome.evidence : null;
        const probe: IsolationProbeEvidence = {
            requestedListKeys,
            provenListKeys: evidence ? provenEnabledListKeys(evidence.proof) : null,
            behavior: evidence
                ? classifyExpectedBehavior({
                      breakage: observedReporterSymptom(evidence),
                      interaction: outcome.interaction,
                      control: controlInteraction,
                  })
                : ExpectedBehaviorState.Indeterminate,
            evidence,
        };
        probes.push(probe);
        return { probe, limitation: outcome.limitation };
    };

    /**
     * Decide whether one recorded probe may be read as evidence about its official subset.
     *
     * The proof is the record: an environment that ignored the narrowing proves a different set,
     * the two differ, and the sweep stops rather than reading the whole baseline as the subset.
     *
     * @param probe - Probe the sweep just recorded.
     * @returns Whether the probe proved the exact state it asked for and could read the page.
     */
    const credited = (probe: IsolationProbeEvidence): boolean =>
        probe.evidence !== null &&
        sameKeys(probe.provenListKeys ?? [], probe.requestedListKeys) &&
        probe.behavior !== ExpectedBehaviorState.Indeterminate;

    const suspects: string[] = [];
    for (const [index, listKey] of officialListKeys.entries()) {
        const requested = officialListKeys.filter((candidate) => candidate !== listKey);
        const { probe, limitation } = await runProbe(requested, String(index));
        if (!credited(probe)) {
            return dispose({ status: IncorrectBlockingStatus.NotIsolated }, limitation);
        }
        if (probe.behavior === ExpectedBehaviorState.Works) {
            suspects.push(listKey);
        }
    }
    // A leave-one-out sweep can only name a single culprit. Several filters that each independently
    // break the page, or none at all, withhold the name rather than picking one arbitrarily.
    if (suspects.length !== 1) {
        return dispose({ status: IncorrectBlockingStatus.NotIsolated });
    }

    const culpritListKey = suspects[0]!;
    const { probe, limitation } = await runProbe([culpritListKey], 'confirm');
    if (!credited(probe) || probe.behavior !== ExpectedBehaviorState.Broken) {
        return dispose({ status: IncorrectBlockingStatus.NotIsolated }, limitation);
    }
    return dispose({ status: IncorrectBlockingStatus.Isolated, culpritListKey });
}

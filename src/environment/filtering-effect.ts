import * as v from 'valibot';

/**
 * Most filtering witnesses one phase may report.
 */
export const MAX_FILTERING_WITNESSES = 64;

export const FilteringWitnessListSchema = v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(300))),
    v.maxLength(MAX_FILTERING_WITNESSES),
);

/**
 * Finite state of the observable filtering the reported baseline was performing.
 */
export const FilteringInvariantState = {
    /**
     * The candidate did not bring back any witness the baseline suppressed.
     */
    Preserved: 'preserved',

    /**
     * The candidate brought back at least one witness the baseline suppressed.
     */
    Regressed: 'regressed',

    /**
     * The run could not bound one of the three phases, so no invariant was proven.
     */
    Untested: 'untested',
} as const;

/**
 * Every filtering invariant state value, for schemas and exhaustive listings.
 */
export const FILTERING_INVARIANT_STATE_VALUES = Object.values(FilteringInvariantState);

/**
 * Filtering invariant state value.
 */
export type FilteringInvariantState =
    (typeof FilteringInvariantState)[keyof typeof FilteringInvariantState];

export const FilteringInvariantStateSchema = v.picklist(FILTERING_INVARIANT_STATE_VALUES);

/**
 * Bounded witness lists the three phases of one experiment reported.
 */
export interface FilteringEffectInput {
    /**
     * Witnesses the filtering-disabled control observed, or null when it reported none.
     */
    control: readonly string[] | null;

    /**
     * Witnesses the reported official baseline observed, or null when it reported none.
     */
    baseline: readonly string[] | null;

    /**
     * Witnesses the candidate phase observed, or null when it reported none.
     */
    candidate: readonly string[] | null;
}

/**
 * What the candidate phase proved about the filtering the reported baseline performed.
 */
export interface FilteringEffectAssessment {
    /**
     * Finite state of that filtering under the candidate.
     */
    state: FilteringInvariantState;

    /**
     * Ascending unique witnesses the reported baseline removed, else empty.
     */
    suppressed: readonly string[];

    /**
     * Ascending subset of those witnesses the candidate brought back, else empty.
     */
    restored: readonly string[];
}

/**
 * Report the one state a run that proved nothing about filtering may claim.
 *
 * @returns The untested assessment with both witness sets empty.
 */
function untested(): FilteringEffectAssessment {
    return { state: FilteringInvariantState.Untested, suppressed: [], restored: [] };
}

/**
 * Read one phase's witness list, failing closed on anything the run cannot bound.
 *
 * @param witnesses - Witness list one phase reported, or null when it reported none.
 * @returns The bounded witnesses, or null when the list is absent or out of bounds.
 */
function boundedWitnesses(witnesses: readonly string[] | null): readonly string[] | null {
    if (witnesses === null) {
        return null;
    }
    const parsed = v.safeParse(FilteringWitnessListSchema, witnesses);
    return parsed.success ? parsed.output : null;
}

/**
 * Decide whether a candidate preserved the filtering its baseline was observably performing.
 *
 * The invariant is derived from the experiment rather than asserted: the control runs with
 * filtering disabled and the baseline with the reported official filters, so whatever the control
 * saw and the baseline did not is filtering those filters provably performed on this page. An empty
 * difference is reported as `untested`, never as proven — that is the exact extent this run
 * tested.
 *
 * @param input - Bounded witness lists for the control, the baseline, and the candidate.
 * @returns The finite invariant state and the witness sets that decided it.
 */
export function assessFilteringInvariant(input: FilteringEffectInput): FilteringEffectAssessment {
    const control = boundedWitnesses(input.control);
    const baseline = boundedWitnesses(input.baseline);
    const candidate = boundedWitnesses(input.candidate);
    if (control === null || baseline === null || candidate === null) {
        return untested();
    }

    const baselineSet = new Set(baseline);
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
    const suppressed = [...new Set(control)].filter((witness) => !baselineSet.has(witness)).sort();
    if (suppressed.length === 0) {
        return untested();
    }

    const candidateSet = new Set(candidate);
    const restored = suppressed.filter((witness) => candidateSet.has(witness));
    return {
        state:
            restored.length > 0
                ? FilteringInvariantState.Regressed
                : FilteringInvariantState.Preserved,
        suppressed,
        restored,
    };
}

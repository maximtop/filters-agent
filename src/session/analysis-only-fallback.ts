/**
 * The safe zero-write outcome a mode continues with when its session sealed without an accepted
 * terminal payload — the same analysis_only shape the legacy parser's fallback produced, with the
 * seal kind and detail carried in the reasoning so the ending stays diagnosable. Used by the
 * pre-orchestrated fix session; the noun naming what it was waiting for is still a named parameter
 * rather than a hardcoded string, so a future mode that seals the same way needs no change here.
 *
 * It lives here rather than beside the seal mapping in `src/tracer/session-trace.ts` because the
 * value it builds is a `FixOutcome`, and the tracer must not depend on the PR layer.
 */
import { FixOutcomeKind, type FixOutcome } from '../pr/fix-outcome';
import type { NonTerminalSeal } from '../pi/seal-types';
import { sealDetail } from '../tracer/session-trace';
import type { ModeSessionResult } from './mode-session';

/**
 * What a mode that continues on this fallback returns: the sealed mode-session result plus the
 * `FixOutcome` the unchanged post-pipeline consumes. Declared once here beside the fallback itself,
 * because the shape exists only for the modes that use it.
 */
export interface AnalysisOnlyModeRun extends ModeSessionResult<FixOutcome> {
    /**
     * The FixOutcome consumed by the unchanged post-pipeline — the accepted payload, or the
     * analysis_only fallback carrying the seal detail.
     */
    fixOutcome: FixOutcome;
}

/**
 * What a mode was waiting for, named in the fallback reasoning. The exact wording is a persisted
 * observable of the run result, and both fix paths plus the agentic seal quote the same noun, so
 * the set is declared once here instead of being respelled per mode.
 */
export const AcceptedSubject = {
    /**
     * The fix run's submitted outcome, pre-orchestrated and agentic alike.
     */
    FixOutcome: 'fix outcome',
} as const;

/**
 * Every AcceptedSubject value, for exhaustive listings.
 */
export const ACCEPTED_SUBJECT_VALUES = Object.values(AcceptedSubject);

/**
 * AcceptedSubject value.
 */
export type AcceptedSubject = (typeof AcceptedSubject)[keyof typeof AcceptedSubject];

/**
 * Build the analysis_only fallback outcome of a non-terminal seal.
 *
 * @param outcome - The non-terminal sealed pi outcome.
 * @param acceptedSubject - What the mode was waiting for, named in the reasoning.
 * @returns The analysis_only fix outcome.
 */
export function analysisOnlyFallback(
    outcome: NonTerminalSeal,
    acceptedSubject: AcceptedSubject,
): FixOutcome {
    return {
        outcome: FixOutcomeKind.AnalysisOnly,
        reasoning:
            `Run sealed without an accepted ${acceptedSubject} ` +
            `(${outcome.kind}): ${sealDetail(outcome)}`,
    };
}

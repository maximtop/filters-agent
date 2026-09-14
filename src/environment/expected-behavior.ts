import * as v from 'valibot';
import type { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { SafeInteractionRefusalReason, type SafeInteractionSummary } from './safe-interaction';

/**
 * Finite state of the reporter's expected behaviour in one phase.
 */
export const ExpectedBehaviorState = {
    /**
     * The expected behaviour was observed working in this phase.
     */
    Works: 'works',

    /**
     * The expected behaviour was observed broken in this phase.
     */
    Broken: 'broken',

    /**
     * The phase could not settle whether the expected behaviour worked or broke.
     */
    Indeterminate: 'indeterminate',
} as const;

/**
 * Every ExpectedBehaviorState value, for schemas and exhaustive listings.
 */
export const EXPECTED_BEHAVIOR_STATE_VALUES = Object.values(ExpectedBehaviorState);

/**
 * ExpectedBehaviorState value.
 */
export type ExpectedBehaviorState =
    (typeof ExpectedBehaviorState)[keyof typeof ExpectedBehaviorState];

export const ExpectedBehaviorStateSchema = v.picklist(EXPECTED_BEHAVIOR_STATE_VALUES);

/**
 * Everything one phase's expected-behaviour verdict is decided from.
 */
export interface ExpectedBehaviorInput {
    /**
     * Vision-owned presence of the reported breakage in this phase.
     */
    breakage: ReporterSymptomPresence;

    /**
     * This phase's interaction summary, or null when the phase required no interaction.
     */
    interaction: SafeInteractionSummary | null;

    /**
     * The filtering-disabled control's summary, or null when this phase is that control.
     */
    control: SafeInteractionSummary | null;
}

/**
 * Read the vision verdict as an expected-behaviour state.
 *
 * The reported symptom of an incorrect-blocking report is the breakage itself, so its presence is
 * the expected behaviour failing and its absence is that behaviour working.
 *
 * @param breakage - Vision-owned presence of the reported breakage.
 * @returns The state the vision reading alone proves.
 */
function fromBreakage(breakage: ReporterSymptomPresence): ExpectedBehaviorState {
    if (breakage === 'present') {
        return ExpectedBehaviorState.Broken;
    }
    return breakage === 'absent'
        ? ExpectedBehaviorState.Works
        : ExpectedBehaviorState.Indeterminate;
}

/**
 * Decide whether the reporter's expected behaviour worked in one phase.
 *
 * A replayed step whose target the control performed and this phase could not is itself the
 * breakage: under one normalized plan the phases differ only by filtering, so an element that
 * stopped being there stopped because filtering removed it.
 *
 * @param input - This phase's vision presence and interaction summary, plus the control's.
 * @returns The finite state this phase proved.
 */
export function classifyExpectedBehavior(input: ExpectedBehaviorInput): ExpectedBehaviorState {
    const interaction = input.interaction;
    if (interaction === null) {
        return fromBreakage(input.breakage);
    }
    const control = input.control;
    // The differential is guarded by a control that drove strictly further under the same plan, so
    // a control that was itself refused or got no further can never widen this phase's verdict.
    if (
        interaction.status === 'refused' &&
        interaction.refusalReason === SafeInteractionRefusalReason.TargetUnavailable &&
        control?.status === 'completed' &&
        control.executedSteps > interaction.executedSteps
    ) {
        return ExpectedBehaviorState.Broken;
    }
    // A sequence that was refused, cut short, or failed never observed the reported behaviour, so
    // the page's vision reading describes something the run did not finish setting up.
    if (interaction.status !== 'completed') {
        return ExpectedBehaviorState.Indeterminate;
    }
    return fromBreakage(input.breakage);
}

import type { ActionLogEntry } from '../environment/environment-proofs';
import type { FilterListKey } from '../environment/filter-list-ref';
import type { Logger } from '../logger/logger';
import type { ApplicationInstructionRefusal } from '../knowledge/instruction-application';
import type { BlockerStateRead, BlockerStateReaderRegistry } from './blocker-state-readers';

/**
 * The declared vocabulary of the between-phases rules application (11-HITL): the goal a run
 * performs toward, its typed outcomes, the bounded session bounds, and the model-runner seam the
 * orchestrator implements over the pi session runner.
 *
 * Decision 1 of 11-HITL fixes the shape both sides code against: the model runs the instruction's
 * steps, the host reads the state back itself and credits only an exact match, and the action log
 * comes from the host-recorded tool trace, never the model's self-report.
 */

/**
 * What one between-phases application is asked to bring the blocker to.
 */
export const ApplicationGoalKind = {
    /**
     * Restore the prepared baseline: no candidate present, the previously proved filter set
     * enabled.
     */
    Baseline: 'baseline',

    /**
     * Apply the candidate rule exactly as written, changing nothing else.
     */
    Candidate: 'candidate',
} as const;

/**
 * Every ApplicationGoalKind value, for schemas and exhaustive listings.
 */
export const APPLICATION_GOAL_KIND_VALUES = Object.values(ApplicationGoalKind);

/**
 * ApplicationGoalKind value.
 */
export type ApplicationGoalKind = (typeof ApplicationGoalKind)[keyof typeof ApplicationGoalKind];

/**
 * The expected blocker state one application run is credited against.
 */
export type ApplicationGoal =
    | {
          /**
           * Plugging the baseline back in: the enabled filter set must equal the prepared one again
           * and no user rule may be present in the credited state.
           */
          kind: typeof ApplicationGoalKind.Baseline;
      }
    | {
          /**
           * The exact rule content the applied state must contain, one line per rule.
           */
          kind: typeof ApplicationGoalKind.Candidate;

          /**
           * The exact candidate rule content, newline-joined when it is a bounded set of lines.
           */
          rule: string;
      };

/**
 * How one application run ended.
 */
export const PhaseApplicationOutcomeKind = {
    /**
     * The host read the state back and it contains exactly the goal's expected content.
     */
    Applied: 'applied',

    /**
     * The instruction's application contract is missing or unsupported: no model turn was made.
     */
    Refused: 'refused',

    /**
     * The steps ran but the state read back does not contain exactly the expected content.
     */
    Unverified: 'unverified',
} as const;

/**
 * Every PhaseApplicationOutcomeKind value, for exhaustive listings.
 */
export const PHASE_APPLICATION_OUTCOME_KIND_VALUES = Object.values(PhaseApplicationOutcomeKind);

/**
 * PhaseApplicationOutcomeKind value.
 */
export type PhaseApplicationOutcomeKind =
    (typeof PhaseApplicationOutcomeKind)[keyof typeof PhaseApplicationOutcomeKind];

/**
 * Turn cap of one application session.
 *
 * Why this value: application is a bounded procedure of enumerated steps, not an investigation —
 * ten turns fit the built-in AdGuard instruction's flow (open the options page, import, save,
 * report) with retry headroom, while two model-driven phases must fit the 15-minute apply_rule
 * deadline beside the A, B and C observation sessions; adjust through AC3's tracked-case parity,
 * not by growing the number silently.
 */
export const APPLICATION_SESSION_MAX_TURNS = 10;

/**
 * Wall-clock budget of one application session in milliseconds.
 *
 * Why this value: the same 15-minute apply_rule deadline hosts two model-driven application passes
 * plus the observation phase they bracket; three minutes per pass leaves the observations their
 * share while absorbing a fresh-install bootstrap (6-10s on fast hardware) many times over. A real
 * tracked case that cannot converge in three minutes is an AC3 parity finding to record, not a
 * number to raise silently.
 */
export const APPLICATION_SESSION_BUDGET_MS = 3 * 60_000;

/**
 * Resolved bounds of one application session.
 */
export interface PhaseApplicationBudget {
    /**
     * Turn cap of the bounded application session.
     */
    turns: number;

    /**
     * Wall-clock budget of the bounded application session in milliseconds.
     */
    budgetMs: number;
}

/**
 * The session one application runs over: the phase lease context the model's page tools act in.
 */
export interface PhaseApplicationSession {
    /**
     * The reported target page the lease observes, for the prompt's target fill.
     */
    targetUrl: string;

    /**
     * The prepared blocker's own management surface (its options page). Exactly this protocol and
     * host are admitted for application sessions; every other navigation is refused.
     */
    blockerSurfaceUrl?: string;

    /**
     * The host-built settings payload the task hands to the session, expressed in the extension's
     * own configuration keys. Absent means no payload was prepared; the task renders an empty
     * fill.
     */
    settingsPayload?: string;

    /**
     * Exact Tracking-protection state the prepared expectation requires the read-back to carry.
     * Absent means no exact expectation is in hand, so a read-back that observes the state still
     * credits on the rules content and enabled filter set alone.
     */
    expectStealthEnabled?: boolean;

    /**
     * Free-form caller context rendered into the session-notes fill.
     */
    notes?: string;

    /**
     * Enabled filter list key set the environment previously proved, compared as a set against the
     * read-back for the Baseline goal.
     */
    baselineEnabledFilterIds?: readonly FilterListKey[];
}

/**
 * One bounded model session the procedure starts over the phase lease.
 */
export interface PhaseApplicationModelRunner {
    /**
     * Run the one bounded application session.
     *
     * @param request - The rendered task prompt, the lease session, the resolved budget, and the
     *   cancellation signal.
     * @returns How the session ended and the host-recorded tool trace of what ran.
     */
    run(request: PhaseApplicationRunnerRequest): Promise<PhaseApplicationRunnerResult>;
}

/**
 * What one runner invocation receives.
 */
export interface PhaseApplicationRunnerRequest {
    /**
     * The rendered application task document.
     */
    prompt: string;

    /**
     * The phase lease session the page tools act in.
     */
    session: PhaseApplicationSession;

    /**
     * Resolved session bounds.
     */
    budget: PhaseApplicationBudget;

    /**
     * Caller cancellation, when the outer deadline provided one.
     */
    signal?: AbortSignal;
}

/**
 * How one runner's session ended, with the host-recorded trace of its tool calls.
 */
export interface PhaseApplicationRunnerResult {
    /**
     * Whether the session ended with an accepted terminal payload. The application verdict never
     * depends on this: the host read-back decides, even when the seal failed.
     */
    completed: boolean;

    /**
     * Bounded detail of the non-completed ending, when there was one.
     */
    detail?: string;

    /**
     * The host-recorded tool calls of the session (never the model's self-report).
     */
    actionLog: ActionLogEntry[];
}

/**
 * Input of one between-phases application run.
 */
export interface PhaseApplicationInput {
    /**
     * Run instruction text whose application contract the procedure parses first.
     */
    application: string;

    /**
     * Expected blocker state the application is credited against.
     */
    goal: ApplicationGoal;

    /**
     * The phase lease session the application run acts over.
     */
    session: PhaseApplicationSession;

    /**
     * The bounded model session runner.
     */
    modelRunner: PhaseApplicationModelRunner;

    /**
     * Reader registry the executor supplies; a declared method absent here is a refusal.
     */
    readBack: BlockerStateReaderRegistry;

    /**
     * Session-bound overrides; defaults to the named application-session constants.
     */
    budget?: Partial<PhaseApplicationBudget>;

    /**
     * Caller cancellation, threaded into the runner.
     */
    signal?: AbortSignal;

    /**
     * Application logger; one default logger otherwise.
     */
    logger?: Logger;
}

/**
 * Result of one between-phases application run.
 */
export type PhaseApplicationResult =
    | {
          /**
           * Discriminator: the state read back contains exactly the goal's expected content.
           */
          kind: typeof PhaseApplicationOutcomeKind.Applied;

          /**
           * Host-assembled tool trace of the application session.
           */
          actionLog: ActionLogEntry[];

          /**
           * The blocker state the host read back itself.
           */
          readBack: BlockerStateRead;

          /**
           * Optional record of what the credit could not observe: a file-backed read-back cannot
           * report the enabled filter set, so its baseline is credited on the empty user-rules
           * state alone and its candidate on the exact user-rules content alone.
           */
          detail?: string;
      }
    | (ApplicationInstructionRefusal & {
          /**
           * Discriminator: the application contract refused before any model turn.
           */
          kind: typeof PhaseApplicationOutcomeKind.Refused;
      })
    | {
          /**
           * Discriminator: steps ran, but the read-back does not contain exactly the expectation.
           */
          kind: typeof PhaseApplicationOutcomeKind.Unverified;

          /**
           * Bounded detail naming the mismatch or the failure the verification hit.
           */
          detail: string;

          /**
           * Host-assembled tool trace of the application session.
           */
          actionLog: ActionLogEntry[];
      };

import {
    ApplicationInstructionGap,
    parseRuleApplication,
    type ApplicationInstructionRefusal,
} from '../knowledge/instruction-application';
import { createLogger } from '../logger/logger';
import { ToolName } from '../agent/tool-names';
import { PromptDocumentName, createPromptDocumentLoader } from '../prompts/prompt-documents';
import type { BlockerStateRead } from './blocker-state-readers';
import { creditBlockerStateRead } from './blocker-state-credit';
import {
    APPLICATION_SESSION_BUDGET_MS,
    APPLICATION_SESSION_MAX_TURNS,
    ApplicationGoalKind,
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationBudget,
    type PhaseApplicationInput,
    type PhaseApplicationResult,
    type PhaseApplicationRunnerResult,
    type PhaseApplicationSession,
} from './phase-application-contract';

/**
 * The model-driven application the host runs between two environment phases.
 *
 * Decision 1 of 11-HITL: the model performs the instruction's application steps in one bounded
 * session over the phase lease, while the host reads the blocker state back itself and credits the
 * phase only when that state contains exactly what the goal expects. A missing application or
 * verification section is a recorded refusal before any model turn — the model never invents a way
 * to apply a rule — and the action log is assembled by the host from the session's recorded tool
 * calls, never from the model's self-report.
 *
 * The credit itself lives in `blocker-state-credit.ts`, shared with the host-performed file-backed
 * application (31-AFK Decision 3), so both application paths judge a read-back by one rule.
 */

/**
 * Render the goal fill the task document carries.
 *
 * @param goal - The expected blocker state.
 * @returns The goal text a model session performs toward.
 */
function applicationGoalText(goal: ApplicationGoal): string {
    if (goal.kind === ApplicationGoalKind.Candidate) {
        return (
            'Apply the candidate rule exactly as written, as one line, changing nothing else:\n\n' +
            goal.rule
        );
    }
    return (
        'Plug the prepared baseline back in: apply no user rule, restore exactly the enabled ' +
        'filter set the environment previously proved, and change nothing else.'
    );
}

/**
 * Render the application task document with strict fills.
 *
 * @param parsedApplication - The instruction's application section content.
 * @param goal - The expected blocker state.
 * @param session - The lease session the fill values come from.
 * @returns The rendered prompt.
 */
function renderApplicationPrompt(
    parsedApplication: string,
    goal: ApplicationGoal,
    session: PhaseApplicationSession,
): string {
    return createPromptDocumentLoader().render(PromptDocumentName.ApplicationTask, {
        applicationContent: parsedApplication,
        goal: applicationGoalText(goal),
        targetUrl: session.targetUrl,
        blockerSurfaceUrl: session.blockerSurfaceUrl ?? '',
        settingsPayload: session.settingsPayload ?? '',
        sessionNotes: session.notes ?? '',
        terminalToolName: ToolName.FinishApplication,
    });
}

/**
 * Resolve the bounded session turns and budget.
 *
 * @param override - Caller overrides, when supplied.
 * @returns The resolved bounds with the named defaults applied.
 */
function resolveBudget(override?: Partial<PhaseApplicationBudget>): PhaseApplicationBudget {
    return {
        turns: override?.turns ?? APPLICATION_SESSION_MAX_TURNS,
        budgetMs: override?.budgetMs ?? APPLICATION_SESSION_BUDGET_MS,
    };
}

/**
 * Describe one verification refusal for the run record.
 *
 * @param refusal - The typed refusal the contract parse produced.
 * @returns The refusal with its refusal kind attached.
 */
function refusedOutcome(refusal: ApplicationInstructionRefusal): PhaseApplicationResult {
    return { kind: PhaseApplicationOutcomeKind.Refused, ...refusal };
}

/**
 * Run one between-phases application: contract refusal, bounded model steps, host read-back.
 *
 * @param input - The instruction, the goal, the lease session, the runner, and the reader registry.
 * @returns Applied when the host read-back contains exactly the goal's content; refused with the
 *   gap when the instruction's contract or the executor's readers cannot honor the application;
 *   unverified with the bounded mismatch detail when the steps ran but the state does not match.
 */
export async function runPhaseApplication(
    input: PhaseApplicationInput,
): Promise<PhaseApplicationResult> {
    const logger = input.logger ?? createLogger();
    const parsed = parseRuleApplication(input.application);
    if ('gap' in parsed) {
        return refusedOutcome(parsed);
    }
    const reader = input.readBack[parsed.verification.method];
    if (reader === undefined) {
        return refusedOutcome({
            gap: ApplicationInstructionGap.VerificationMethodUnsupported,
            detail:
                `The state verification declares method "${parsed.verification.method}", which ` +
                'this executor supplies no read-back reader for.',
        });
    }

    // The model session runs once, bounded, over the phase lease; the trace below is the host's
    // record of it, never the model's report of itself.
    const budget = resolveBudget(input.budget);
    let runnerResult: PhaseApplicationRunnerResult | undefined;
    try {
        runnerResult = await input.modelRunner.run({
            prompt: renderApplicationPrompt(parsed.application.content, input.goal, input.session),
            session: input.session,
            budget,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    } catch (error) {
        logger.error(
            {
                err: error,
                method: parsed.verification.method,
                goal: input.goal.kind,
            },
            'phase application session threw before its seal',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail: `The application session did not end: ${error instanceof Error ? error.message : String(error)}`,
            actionLog: [],
        };
    }
    if (!runnerResult.completed) {
        logger.warn(
            {
                detail: runnerResult.detail,
                actionCount: runnerResult.actionLog.length,
            },
            'phase application session ended without an accepted terminal payload',
        );
    }

    let read: BlockerStateRead;
    try {
        read = await reader(parsed.verification);
    } catch (error) {
        logger.error(
            {
                err: error,
                method: parsed.verification.method,
            },
            'the host read-back of the blocker state failed',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                `The ${parsed.verification.method} read-back failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            actionLog: runnerResult.actionLog,
        };
    }

    return creditBlockerStateRead({
        read,
        goal: input.goal,
        method: parsed.verification.method,
        actionLog: runnerResult.actionLog,
        ...(input.session.baselineEnabledFilterIds === undefined
            ? {}
            : { preparedEnabledFilterIds: input.session.baselineEnabledFilterIds }),
        ...(input.session.expectStealthEnabled === undefined
            ? {}
            : { expectedStealthEnabled: input.session.expectStealthEnabled }),
        logger,
    });
}

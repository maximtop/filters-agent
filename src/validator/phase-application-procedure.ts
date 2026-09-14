import {
    ApplicationInstructionGap,
    parseRuleApplication,
    type ApplicationInstructionRefusal,
} from '../knowledge/instruction-application';
import type { ActionLogEntry, BlockerVerificationMethod } from '../environment/environment-proofs';
import { createLogger, type Logger } from '../logger/logger';
import { ToolName } from '../agent/tool-names';
import { PromptDocumentName, createPromptDocumentLoader } from '../prompts/prompt-documents';
import {
    normalizeRulesContent,
    observedRulesDigest,
    sha256OfContent,
} from '../environment/rules-content';
import { sortListKeys, type FilterListKey } from '../environment/filter-list-ref';
import type { BlockerStateRead } from './blocker-state-readers';
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
 */

/**
 * Whether two filter list key collections are the same set.
 *
 * @param left - One collection of list keys.
 * @param right - The other collection of list keys.
 * @returns True when both carry exactly the same distinct keys.
 */
function sameKeySet(left: readonly FilterListKey[], right: readonly FilterListKey[]): boolean {
    const sortedLeft = sortListKeys([...new Set(left)]);
    const sortedRight = sortListKeys([...new Set(right)]);
    return (
        sortedLeft.length === sortedRight.length &&
        sortedLeft.every((key, index) => key === sortedRight[index])
    );
}

/**
 * Required keys absent from an available collection, in ascending registry order.
 *
 * @param required - Keys that must all be present.
 * @param available - The observed key collection to check membership against.
 * @returns The required keys `available` does not contain; empty when it contains every one.
 */
function missingKeys(
    required: readonly FilterListKey[],
    available: readonly FilterListKey[],
): FilterListKey[] {
    const availableSet = new Set(available);
    return sortListKeys(required.filter((key) => !availableSet.has(key)));
}

/**
 * Judge the enabled filter set and Tracking-protection state a matching read-back reports against
 * the prepared expectation, the last step of both goals: the baseline plugs exactly that set back
 * in, and the candidate is applied on top of it. This is the only place the prepared state is
 * judged; the environment that consumes the result trusts it. A reader that cannot observe the set
 * (the file-backed methods) credits on the rules content alone and records that in the detail; a
 * reader that cannot observe stealth leaves the Tracking-protection state out of the judgment.
 *
 * @param read - The host read-back whose rules content already matched the goal.
 * @param goal - The goal being credited, which names what the rules content proved.
 * @param prepared - The prepared enabled list key set of the phase session.
 * @param expectedStealth - The prepared Tracking-protection state, when one is known exactly.
 * @param method - The verification method that produced the read-back.
 * @param actionLog - The host-assembled trace of the application session.
 * @param logger - Run logger for the outcome.
 * @returns Applied, with the unobservable-set detail when the reader cannot report the set, or
 *   unverified with the bounded mismatch.
 */
function judgeEnabledFilterSet(
    read: BlockerStateRead,
    goal: ApplicationGoal,
    prepared: readonly FilterListKey[] | undefined,
    expectedStealth: boolean | undefined,
    method: BlockerVerificationMethod,
    actionLog: ActionLogEntry[],
    logger: Logger,
): PhaseApplicationResult {
    if (
        read.stealthEnabled !== undefined &&
        expectedStealth !== undefined &&
        read.stealthEnabled !== expectedStealth
    ) {
        logger.warn(
            {
                goal: goal.kind,
                expectedStealth,
                observedStealth: read.stealthEnabled,
            },
            'the read-back Tracking-protection state does not match the prepared state',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The Tracking-protection state read back does not equal the prepared state: ' +
                `observed ${read.stealthEnabled ? 'enabled' : 'disabled'} where ` +
                `${expectedStealth ? 'enabled' : 'disabled'} was expected.`,
            actionLog,
        };
    }
    const credited =
        goal.kind === ApplicationGoalKind.Candidate
            ? 'the candidate was credited on the exact user-rules content alone'
            : 'the baseline was credited on the empty user-rules state alone';
    const observed = read.enabledFilterIds;
    if (observed === undefined) {
        logger.info(
            { method, goal: goal.kind },
            'the read-back does not expose the enabled filter set; credited on the rules content alone',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Applied,
            actionLog,
            readBack: read,
            detail: `The ${method} read-back does not expose the enabled filter set; ${credited}.`,
        };
    }
    if (prepared === undefined) {
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The phase session carried no prepared enabled filter set to compare the read-back ' +
                'against.',
            actionLog,
        };
    }
    if (!sameKeySet(prepared, observed)) {
        logger.warn(
            {
                goal: goal.kind,
                preparedKeys: sortListKeys([...prepared]),
                observedKeys: sortListKeys([...observed]),
            },
            'the enabled filter list set does not match the prepared set',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The enabled filter list set read back does not equal the prepared baseline set: ' +
                `observed [${sortListKeys([...new Set(observed)]).join(', ')}].`,
            actionLog,
        };
    }
    // Requested/options credit alone proves a filter is switched on, never that its MV3 ruleset
    // actually compiled and activated within the browser's limits — the deleted options-page
    // driver rejected both gaps, and a reader that can observe them (the live extension state)
    // must still be held to the same bar.
    if (read.limitsExceeded === true) {
        logger.warn(
            { goal: goal.kind },
            'the read-back reports MV3 filter or rule limits exceeded',
        );
        return {
            kind: PhaseApplicationOutcomeKind.Unverified,
            detail:
                'The read-back reports MV3 filter or rule limits exceeded after the application; ' +
                'the requested filters cannot be trusted to run.',
            actionLog,
        };
    }
    if (read.activeRulesetFilterIds !== undefined) {
        const missing = missingKeys(prepared, read.activeRulesetFilterIds);
        if (missing.length > 0) {
            logger.warn(
                {
                    goal: goal.kind,
                    preparedKeys: sortListKeys([...prepared]),
                    activeRulesetKeys: sortListKeys([...read.activeRulesetFilterIds]),
                },
                'the active MV3 rulesets do not contain every expected filter',
            );
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The active MV3 rulesets do not contain every expected filter: missing ' +
                    `[${missing.join(', ')}] from the active set ` +
                    `[${sortListKeys([...read.activeRulesetFilterIds]).join(', ')}].`,
                actionLog,
            };
        }
    }
    return { kind: PhaseApplicationOutcomeKind.Applied, actionLog, readBack: read };
}

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

    if (input.goal.kind === ApplicationGoalKind.Candidate) {
        // Both sides digest through the one normalization: the reader reports content normalized,
        // and the expected rule is normalized the same way, so a trailing newline on the goal rule
        // cannot make an exact application look mismatched.
        const observedDigest = observedRulesDigest(read);
        if (observedDigest === undefined) {
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail: 'The read-back state carried no user-rules content to compare against the candidate.',
                actionLog: runnerResult.actionLog,
            };
        }
        const expectedDigest = sha256OfContent(normalizeRulesContent(input.goal.rule));
        if (observedDigest !== expectedDigest) {
            logger.warn(
                {
                    expectedDigest,
                    observedDigest,
                    observedRuleCount:
                        read.rulesContent === undefined
                            ? undefined
                            : read.rulesContent.split('\n').length,
                },
                'the blocker state does not contain exactly the candidate',
            );
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The blocker state does not contain exactly the candidate rule: the host read ' +
                    `back content digest ${observedDigest} where ${expectedDigest} was expected.`,
                actionLog: runnerResult.actionLog,
            };
        }
        return judgeEnabledFilterSet(
            read,
            input.goal,
            input.session.baselineEnabledFilterIds,
            input.session.expectStealthEnabled,
            parsed.verification.method,
            runnerResult.actionLog,
            logger,
        );
    } else {
        // The baseline contract requires no user rule in the credited state, which only the rules
        // content itself can show: a read-back without it (a digest alone) proves nothing about
        // absence, so it is refused rather than collapsed to "empty".
        if (read.rulesContent === undefined) {
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    `The ${parsed.verification.method} read-back reported no rules content, so ` +
                    'the absence of user rules in the baseline state cannot be shown.',
                actionLog: runnerResult.actionLog,
            };
        }
        // Any content left after the shared normalization fails the credit, whatever the enabled
        // filter list says.
        const leftoverRules = normalizeRulesContent(read.rulesContent);
        if (leftoverRules.length > 0) {
            const ruleLineCount = leftoverRules.split('\n').length;
            logger.warn(
                {
                    method: parsed.verification.method,
                    ruleLineCount,
                },
                'the baseline state still carries user rules',
            );
            return {
                kind: PhaseApplicationOutcomeKind.Unverified,
                detail:
                    'The baseline state must contain no user rules, but the ' +
                    `${parsed.verification.method} read-back still reports ` +
                    `${ruleLineCount} rule line(s): ${leftoverRules}`,
                actionLog: runnerResult.actionLog,
            };
        }
        return judgeEnabledFilterSet(
            read,
            input.goal,
            input.session.baselineEnabledFilterIds,
            input.session.expectStealthEnabled,
            parsed.verification.method,
            runnerResult.actionLog,
            logger,
        );
    }
}

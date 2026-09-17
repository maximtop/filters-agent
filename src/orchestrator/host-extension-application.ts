/**
 * The host-performed application of the built-in AdGuard Browser Extension route.
 *
 * The route's steps are a fixed message protocol, not a judgement — wait for the fresh-install
 * bootstrap, import the settings document the host already built, turn off whatever filter the
 * import left on that the prepared expectation does not name, and for a candidate phase save the
 * rule as the one user rule. Driving that through a model cost 20-50 seconds a turn, five to eight
 * minutes an application, two applications an experiment, and regularly overran the 30-minute
 * `apply_rule` deadline without even sealing a terminal payload. So the host sends the messages
 * itself, in the order `src/prompts/documents/instructions/adguard-extension.md` specifies — that
 * document remains the contract this module implements.
 *
 * What does not move: the runner never decides whether the phase applied. It reports how far it got
 * and the trace of what it did; `phase-application-procedure.ts` reads the live extension state
 * back afterwards and `blocker-state-credit.ts` credits only an exact match, exactly as it does for
 * a model-driven instruction.
 *
 * Bounds: the model-driven session's turn cap and wall-clock budget
 * (`APPLICATION_SESSION_MAX_TURNS`, `APPLICATION_SESSION_BUDGET_MS`) do not apply here and are
 * ignored when the procedure hands them over. This runner is bounded by the extension-readiness
 * deadline every host read of the blocker state shares — one shared wall-clock budget across the
 * bootstrap wait and every options read — and by the request's abort signal, which is checked
 * before each step and between reconciliation rounds so a phase the outer deadline already
 * abandoned stops instead of writing on behind it.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { AdGuardExtensionMessageType } from '../browser/adguard-extension-message-types';
import {
    normalizeReadFilterIds,
    waitForAppInitialized,
    waitForOptionsData,
} from '../browser/adguard-extension-state-read';
import {
    DEFAULT_READINESS_BUDGET_MS,
    sendExtensionMessage,
} from '../browser/adguard-extension-state-transport';
import {
    PROOF_APPLICATION_DETAIL_MAX,
    type ActionLogEntry,
} from '../environment/environment-proofs';
import { HostApplicationStep } from '../environment/host-application-step';
import {
    boundedText,
    failureReason,
    hostApplicationStepPerformer,
    HostApplicationStepFailure,
    type HostApplicationStepPerformer,
} from './host-application-step-log';
import { normalizeRulesContent } from '../environment/rules-content';
import type { Logger } from '../logger/logger';
import {
    ApplicationGoalKind,
    type ApplicationGoal,
    type PhaseApplicationRunner,
    type PhaseApplicationRunnerResult,
} from '../validator/phase-application-contract';
import { overDedicatedSurfacePage } from './phase-application-extension-surface';

/**
 * How many times the host may turn unexpected filters off and re-read the enabled set.
 *
 * Why this value: a successful `applySettingsJson` is not proof of the expected set — the extension
 * re-enables some filters from settings of its own after an import, and a live run read back `[2,
 * 3, 10]` against the prepared `[2, 3]`. One more read-and-disable pass settles that; three bounds
 * a build that keeps re-enabling from looping forever, and is the count the built-in instruction
 * document has always specified (the retired options-page driver used the same).
 */
const FILTER_RECONCILIATION_ROUNDS = 3;

/**
 * Everything one host-performed AdGuard application acts on beyond what the runner request carries.
 */
export interface HostExtensionApplicationInput {
    /**
     * The expected blocker state this application performs toward: the candidate rule to save, or
     * the baseline that saves none.
     */
    goal: ApplicationGoal;

    /**
     * Exact official filter IDs the prepared expectation names, in the extension's own registry
     * numbering. Every enabled filter outside this set is turned off; nothing is ever turned on.
     */
    expectedFilterIds: readonly number[];

    /**
     * The lease session's persistent extension context the dedicated surface page is opened on.
     */
    context: BrowserContext;

    /**
     * Wall-clock budget shared by the bootstrap wait and every options read of this application;
     * the shared transport default when the run configures none.
     */
    readinessBudgetMs?: number;

    /**
     * Run logger receiving every step with its duration, and every failure with its caught error.
     */
    logger: Logger;
}

/**
 * What the enabled-filter reconciliation observed.
 */
interface FilterReconciliation {
    /**
     * How many read-and-disable rounds ran; zero when the import already landed on exactly the
     * expected set.
     */
    rounds: number;

    /**
     * Filter IDs the host turned off, ascending and distinct.
     */
    disabledFilterIds: number[];

    /**
     * Filter IDs still enabled outside the expected set when the rounds ran out; empty when the
     * enabled set converged.
     */
    unexpectedFilterIds: number[];
}

/**
 * One read of the extension's enabled filter set during reconciliation.
 */
interface ObservedEnabledFilters {
    /**
     * Every filter the extension reports enabled, ascending and distinct.
     */
    enabled: number[];

    /**
     * The subset of those the prepared expectation does not name.
     */
    unexpected: number[];
}

/**
 * Maximum characters of an extension reply quoted into a step summary.
 *
 * A reply the protocol defines is a boolean or a small record; quoting more than this would push
 * the step's own facts out of the summary's 200-character ceiling.
 */
const REPLY_TOKEN_MAX = 40;

/**
 * Reduce one extension reply to a short token for a step summary.
 *
 * @param reply - Whatever the options application answered.
 * @returns A bounded serialization of the reply.
 */
function replyToken(reply: unknown): string {
    return boundedText(JSON.stringify(reply) ?? String(reply), REPLY_TOKEN_MAX);
}

/**
 * Whether one extension reply is the protocol's explicit refusal.
 *
 * The pinned build answers `applySettingsJson` and `saveUserRules` with a boolean, and `false`
 * means it applied nothing. It is recorded as a step that did not do what it was asked rather than
 * thrown: the read-back still decides the phase, and it will say precisely what the state is.
 *
 * @param reply - Whatever the options application answered.
 * @returns True when the reply is exactly `false`.
 */
function replyRefused(reply: unknown): boolean {
    return reply === false;
}

/**
 * Read the enabled filter set and turn off everything outside the prepared expectation.
 *
 * Step 4 of the built-in instruction document, verbatim: a successful import is not proof of the
 * expected set, so the host reads `getOptionsData`, sends `disableFilter` for every enabled filter
 * whose ID the expectation does not name, and re-reads. Nothing is ever enabled here — the import
 * is the only step that turns filters on, and the protocol has no enable counterpart at all.
 *
 * @param page - The dedicated surface page the messages are sent from.
 * @param expectedFilterIds - Exact official filter IDs the prepared expectation names.
 * @param readinessDeadlineAt - Absolute deadline shared with every other read of this application.
 * @param logger - Run logger receiving each round.
 * @param signal - Caller cancellation, checked between rounds.
 * @returns What the reconciliation observed: rounds run, filters disabled, filters still
 *   unexpected.
 * @throws When an options read or a disable message fails, or the deadline aborts between rounds.
 */
async function reconcileEnabledFilters(
    page: Page,
    expectedFilterIds: readonly number[],
    readinessDeadlineAt: number,
    logger: Logger,
    signal: AbortSignal | undefined,
): Promise<FilterReconciliation> {
    const expected = new Set(expectedFilterIds);
    const disabled = new Set<number>();

    /**
     * Read the options metadata and name the enabled filters the expectation does not.
     *
     * @returns The enabled set and the unexpected subset of it, both ascending and distinct.
     */
    const readUnexpected = async (): Promise<ObservedEnabledFilters> => {
        const optionsData = await waitForOptionsData(page, readinessDeadlineAt);
        const enabled = normalizeReadFilterIds(
            optionsData.filtersMetadata.filters
                .filter((filter) => filter.enabled)
                .map((filter) => filter.filterId),
        );
        return { enabled, unexpected: enabled.filter((filterId) => !expected.has(filterId)) };
    };

    let observed = await readUnexpected();
    let rounds = 0;
    while (observed.unexpected.length > 0 && rounds < FILTER_RECONCILIATION_ROUNDS) {
        if (signal?.aborted ?? false) {
            throw new Error('the phase deadline aborted between two reconciliation rounds');
        }
        rounds += 1;
        logger.warn(
            {
                round: rounds,
                expectedFilterIds: [...expected],
                enabledFilterIds: observed.enabled,
                unexpectedFilterIds: observed.unexpected,
            },
            'the import left filters enabled the prepared expectation does not name; turning them off',
        );
        for (const filterId of observed.unexpected) {
            await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.DisableFilter,
                data: { filterId },
            });
            disabled.add(filterId);
        }
        observed = await readUnexpected();
    }
    const disabledFilterIds = normalizeReadFilterIds([...disabled]);
    if (observed.unexpected.length === 0) {
        logger.info(
            { rounds, disabledFilterIds, enabledFilterIds: observed.enabled },
            'the enabled filter set matches the prepared expectation',
        );
    } else {
        logger.error(
            {
                rounds,
                disabledFilterIds,
                expectedFilterIds: [...expected],
                enabledFilterIds: observed.enabled,
                unexpectedFilterIds: observed.unexpected,
            },
            'the enabled filter set did not converge within the reconciliation rounds',
        );
    }
    return { rounds, disabledFilterIds, unexpectedFilterIds: observed.unexpected };
}

/**
 * Send the protocol the built-in document specifies over one loaded surface page.
 *
 * @param page - The dedicated surface page, already loaded on the prepared management surface.
 * @param input - The goal, the expected filter IDs and the readiness budget.
 * @param settingsPayload - The complete settings-import document the host built, passed as handed.
 * @param step - The recorded-step performer.
 * @param signal - Caller cancellation.
 * @returns Nothing; each step's own record says what it did.
 * @throws {HostApplicationStepFailure} When a step fails.
 */
async function performExtensionApplication(
    page: Page,
    input: HostExtensionApplicationInput,
    settingsPayload: string,
    step: HostApplicationStepPerformer,
    signal: AbortSignal | undefined,
): Promise<void> {
    const { goal, expectedFilterIds, logger } = input;
    const readinessBudgetMs = input.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS;
    const readinessDeadlineAt = Date.now() + readinessBudgetMs;

    await step(
        HostApplicationStep.AwaitExtensionReady,
        async () => await waitForAppInitialized(page, readinessDeadlineAt),
        () => ({
            ok: true,
            summary:
                'the extension reported its fresh-install bootstrap finished within the ' +
                `${readinessBudgetMs}ms readiness budget`,
        }),
    );

    await step(
        HostApplicationStep.ApplyExtensionSettings,
        async () =>
            await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.ApplySettingsJson,
                data: { json: settingsPayload },
            }),
        (reply) => ({
            ok: !replyRefused(reply),
            summary:
                `imported the ${settingsPayload.length}-byte settings document naming ` +
                `${expectedFilterIds.length} official filter(s); the options application ` +
                `answered ${replyToken(reply)}`,
        }),
    );

    await step(
        HostApplicationStep.ReconcileEnabledFilters,
        async () =>
            await reconcileEnabledFilters(
                page,
                expectedFilterIds,
                readinessDeadlineAt,
                logger,
                signal,
            ),
        (reconciliation) => ({
            ok: reconciliation.unexpectedFilterIds.length === 0,
            summary:
                reconciliation.unexpectedFilterIds.length === 0
                    ? `the enabled set matched after ${reconciliation.rounds} round(s); ` +
                      `turned off [${reconciliation.disabledFilterIds.join(', ')}]`
                    : `[${reconciliation.unexpectedFilterIds.join(', ')}] stayed enabled after ` +
                      `${reconciliation.rounds} round(s); turned off ` +
                      `[${reconciliation.disabledFilterIds.join(', ')}]`,
        }),
    );

    if (goal.kind !== ApplicationGoalKind.Candidate) {
        // The document prescribes no user-rules step for the Baseline goal, and none is needed: a
        // phase session always bootstraps a fresh profile, so it starts with no user rule, and the
        // settings document imported above is that same profile's own export. Sending an empty
        // `saveUserRules` here would be a step the contract does not name.
        logger.info(
            { goal: goal.kind },
            'the baseline goal leaves the user rules untouched: a fresh phase profile carries none',
        );
        return;
    }
    const rule = normalizeRulesContent(goal.rule);
    await step(
        HostApplicationStep.SaveExtensionUserRules,
        async () =>
            await sendExtensionMessage(page, {
                type: AdGuardExtensionMessageType.SaveUserRules,
                data: { value: rule },
            }),
        (reply) => ({
            ok: !replyRefused(reply),
            summary:
                `saved the candidate as the only user rule (${rule.split('\n').length} line(s), ` +
                `${rule.length} bytes); the options application answered ${replyToken(reply)}`,
        }),
    );
}

/**
 * Create the host-performed application runner of the built-in AdGuard route.
 *
 * The runner opens one throwaway page on the prepared management surface, sends the document's
 * message protocol over it, and closes the page whether the protocol finished or threw. It reports
 * only how far it got and the trace of what it did — never a verdict: the procedure that called it
 * reads the live extension state back afterwards and credits the phase on that alone.
 *
 * @param input - The goal, the expected filter IDs, the lease context, the readiness budget and the
 *   run logger.
 * @returns The runner the between-phases application procedure performs through.
 */
export function createHostExtensionApplicationRunner(
    input: HostExtensionApplicationInput,
): PhaseApplicationRunner {
    return {
        run: async (request): Promise<PhaseApplicationRunnerResult> => {
            const { logger } = input;
            const actionLog: ActionLogEntry[] = [];
            const blockerSurfaceUrl = request.session.blockerSurfaceUrl;
            const settingsPayload = request.session.settingsPayload;
            if (blockerSurfaceUrl === undefined || settingsPayload === undefined) {
                const missing = [
                    ...(blockerSurfaceUrl === undefined
                        ? ['the prepared blocker management surface']
                        : []),
                    ...(settingsPayload === undefined ? ['the prepared settings document'] : []),
                ];
                const detail =
                    'The host has nothing to apply the prepared state through: ' +
                    `${missing.join(' and ')} could not be prepared for this phase.`;
                logger.error(
                    {
                        goal: input.goal.kind,
                        hasBlockerSurfaceUrl: blockerSurfaceUrl !== undefined,
                        hasSettingsPayload: settingsPayload !== undefined,
                    },
                    'the host-performed application has no prepared surface or settings document',
                );
                return {
                    completed: false,
                    detail: boundedText(detail, PROOF_APPLICATION_DETAIL_MAX),
                    actionLog,
                };
            }
            const step = hostApplicationStepPerformer(actionLog, logger, request.signal);
            logger.info(
                {
                    goal: input.goal.kind,
                    blockerSurfaceUrl,
                    expectedFilterIds: [...input.expectedFilterIds],
                    settingsPayloadBytes: settingsPayload.length,
                    readinessBudgetMs: input.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS,
                },
                'the host performs this phase application itself: import, reconcile, save',
            );
            try {
                await overDedicatedSurfacePage(
                    input.context,
                    blockerSurfaceUrl,
                    logger,
                    async (page) =>
                        await performExtensionApplication(
                            page,
                            input,
                            settingsPayload,
                            step,
                            request.signal,
                        ),
                );
            } catch (error) {
                if (error instanceof HostApplicationStepFailure) {
                    return {
                        completed: false,
                        detail: boundedText(error.message, PROOF_APPLICATION_DETAIL_MAX),
                        actionLog,
                    };
                }
                // Everything left is the surface page itself: opening or loading it failed before
                // any step could run, so there is no step to name.
                logger.error(
                    { err: error, blockerSurfaceUrl, goal: input.goal.kind },
                    'the host could not open the prepared blocker management surface to apply over',
                );
                return {
                    completed: false,
                    detail: boundedText(
                        'The host could not open the prepared blocker management surface ' +
                            `${blockerSurfaceUrl}: ${failureReason(error)}`,
                        PROOF_APPLICATION_DETAIL_MAX,
                    ),
                    actionLog,
                };
            }
            const incomplete = actionLog.find((entry) => !entry.ok);
            if (incomplete !== undefined) {
                return {
                    completed: false,
                    detail: boundedText(
                        `The host application step "${incomplete.tool}" did not complete: ` +
                            incomplete.summary,
                        PROOF_APPLICATION_DETAIL_MAX,
                    ),
                    actionLog,
                };
            }
            return { completed: true, actionLog };
        },
    };
}

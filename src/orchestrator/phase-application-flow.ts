import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import type {
    AdGuardExtensionOptionsData,
    AdGuardExtensionStateRead,
} from '../browser/adguard-extension-state-shapes';
import { DISABLE_STEALTH_SETTING } from '../browser/adguard-extension-settings';
import {
    readAdGuardExtensionState as readAdGuardExtensionStateDefault,
} from '../browser/adguard-extension-state-read';
import {
    findExtensionRuntime as findExtensionRuntimeDefault,
} from '../browser/extension-runtime-location';
import type { IBrowserSession } from '../browser/browser-interfaces';
import {
    EnvironmentPhaseConfigurationOutcome,
    type EnvironmentPhaseConfigurationRequest,
} from '../environment/browser-extension-environment';
import { BlockerVerificationMethod } from '../environment/environment-proofs';
import { adguardListKey, parseAdguardListKey } from '../environment/filter-list-ref';
import { createLogger } from '../logger/logger';
import {
    ApplicationInstructionGap,
    parseRuleApplication,
    type ApplicationInstructionRefusal,
} from '../knowledge/instruction-application';
import {
    createPhaseApplicationModelRunner as buildPhaseApplicationModelRunner,
} from './application-session';
import {
    buildExtensionSettingsPayload,
    type ExtensionSettingsPayloadExpectation,
} from './application-write-channel';
import {
    PhaseApplicationOutcomeKind,
    type ApplicationGoal,
    type PhaseApplicationModelRunner,
} from '../validator/phase-application-contract';
import { runPhaseApplication } from '../validator/phase-application-procedure';
import {
    fileBlockerStateReader,
    type BlockerStateReader,
} from '../validator/blocker-state-readers';
import type { AgentRuntimeSessionState } from './agent-runtime-session-evidence';
import {
    canonicalPhaseApplicationOrigin,
    expectedStealthEnabledFor,
    filterLimitsExceededFor,
    requiredExtensionGroupIds,
} from './phase-application-wiring';
import { PhaseLabel } from '../types/validation';
import type {
    EnvironmentBlockerStateCapture,
    PhaseApplicationFlowHost,
    PhaseApplicationModelRunnerDependencies,
    RuntimeApplicationOutcome,
} from './phase-application-flow-host';

/**
 * The between-phases application procedure: run the instruction's steps over a lease session, then
 * read the blocker state back and map the result onto the adapter's configuration seam.
 *
 * This module owns the flow `agent-runtime.ts` used to run inline (`runApplication` through the
 * model-runner and read-back helpers it composes): the same operations, now taking their runtime
 * dependencies as an explicit host object instead of `this`, so the flow is callable — and testable
 * — without the whole runtime class. `phase-application-flow-host.ts` declares the host and
 * dependency contracts this flow acts through and the shape one application call returns.
 * `phase-application-launch.ts` builds on this module for the launch-time Baseline application;
 * neither this module, `phase-application-flow-host.ts`, nor `phase-application-launch.ts` imports
 * `agent-runtime.ts`, so the dependency runs one way only.
 */

/**
 * Resolution of one declared file-backed verification target: either the absolute path the
 * file-backed read-back is admitted to read, or the typed refusal recording why the declaration
 * cannot be honored. Structurally discriminated like the rule-application parse: a member carrying
 * `gap` is the refusal.
 */
type BlockerFileTargetResolution =
    | {
          /**
           * The absolute path the file-backed read-back is admitted to read.
           */
          path: string;
      }
    | ApplicationInstructionRefusal;

/**
 * Resolve one declared file-backed verification target against the run's checkout root.
 *
 * The file-backed declarations name the state the run's preparation and application steps maintain,
 * as the instruction writes it: a relative target is that file's checkout-root-relative path — the
 * same base the instruction loader resolves the instruction and its links against
 * (`PhaseApplicationFlowHost.filtersPath`, the pinned filters checkout) — and an absolute target is
 * honored as-is, as part of the instruction's trusted content (D20). A relative target whose
 * resolution escapes the checkout root is a typed refusal: the host contains file-backed read-backs
 * to the checkout, and the refused target is never read.
 *
 * @param filtersPath - The run's checkout root the relative reference resolves against.
 * @param target - Declared target exactly as the instruction wrote it.
 * @returns The absolute path the file-backed read-back is admitted to read, or the typed refusal
 *   recording why the declaration cannot be honored.
 */
function resolveBlockerFileTarget(
    filtersPath: string,
    target: string,
): BlockerFileTargetResolution {
    if (isAbsolute(target)) {
        return { path: target };
    }
    const resolved = resolve(filtersPath, target);
    // Containment by the target's position relative to the checkout root: a first `..` segment
    // (or a cross-root resolution that no longer names a position under the root) is the escape.
    const relativeToRoot = relative(filtersPath, resolved);
    const leadingSegment = relativeToRoot.split(sep, 1)[0];
    if (leadingSegment === '..' || isAbsolute(relativeToRoot)) {
        return {
            gap: ApplicationInstructionGap.VerificationTargetOutsideCheckout,
            detail:
                'The state verification declares a checkout-relative target that resolves ' +
                `outside the run's checkout root ("${target}"); the host contains file-backed ` +
                'read-backs to the checkout and refuses this target before reading it.',
        };
    }
    return { path: resolved };
}

/**
 * Refuse a blocker read-back whose application session was already aborted.
 *
 * The abort means the launch tool already answered the model with its deadline result; the late
 * read-back must not run, and the application procedure logs the thrown error and seals the
 * application unverified instead of crediting a state the model was told had failed.
 *
 * @param request - The phase-configuration request carrying the caller's cancellation.
 * @throws Error naming the aborted read-back.
 */
function assertApplicationNotAborted(request: EnvironmentPhaseConfigurationRequest): void {
    if (request.signal?.aborted) {
        throw new Error(
            'The application session was aborted before the blocker state read-back; the ' +
                'late read-back is discarded.',
        );
    }
}

/**
 * Build the bounded application-session runner for one configuration call, or undefined when the
 * request's deadline already aborted.
 *
 * @param host - The runtime seam this flow acts through.
 * @param session - The lease session the runner acts on.
 * @param request - The phase-configuration request carrying cancellation.
 * @returns The model runner, or undefined when the request was already aborted (a test's injected
 *   factory may still decline for its own reason).
 */
function phaseApplicationModelRunner(
    host: PhaseApplicationFlowHost,
    session: IBrowserSession,
    request: EnvironmentPhaseConfigurationRequest,
): PhaseApplicationModelRunner | undefined {
    const { llm, piRuntime } = host;
    const logger = createLogger({ verbose: host.verbose });
    const depends: PhaseApplicationModelRunnerDependencies = {
        runtime: piRuntime,
        llm,
        recorder: host.recorder,
        session,
        allowedOrigin: canonicalPhaseApplicationOrigin(request.targetUrl),
        logger,
        usageCollector: host.usageCollector,
    };
    if (host.createPhaseApplicationModelRunner) {
        return host.createPhaseApplicationModelRunner(depends);
    }
    if (request.signal?.aborted ?? false) {
        return undefined;
    }
    return buildPhaseApplicationModelRunner({
        runtime: piRuntime,
        llm,
        recorder: host.recorder,
        session,
        allowedOrigin: canonicalPhaseApplicationOrigin(request.targetUrl),
        logger,
        usageCollector: host.usageCollector,
    });
}

/**
 * Locate the prepared blocker's own management surface for the application session.
 *
 * @param host - The runtime seam this flow acts through.
 * @param state - Prepared session naming the verified extension build.
 * @param context - The lease session's persistent context to search.
 * @returns The options-page URL, or undefined when the runtime could not be located (the refusal
 *   detail is logged; the application proceeds with the read tools only).
 */
async function preparedBlockerSurfaceUrl(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    context: BrowserContext,
): Promise<string | undefined> {
    const extension = state.extension;
    if (!extension) {
        return undefined;
    }
    const find = host.findExtensionRuntime ?? findExtensionRuntimeDefault;
    try {
        const runtime = await find(context, extension.manifestVersion);
        return `chrome-extension://${runtime.extensionId}/pages/options.html`;
    } catch (error) {
        createLogger({ verbose: host.verbose }).warn(
            {
                error: error instanceof Error ? error.message : String(error),
                manifestVersion: extension.manifestVersion,
            },
            'the prepared blocker management surface could not be located',
        );
        return undefined;
    }
}

/**
 * Build the settings payload over a page dedicated to this one host-to-extension exchange.
 *
 * No model turn has run when this is called, so the application session's own page can be
 * anywhere — a fresh phase session opens with no navigation of its own. This opens and navigates a
 * throwaway page instead, exactly like every other host read-back of the blocker state
 * (`readAdGuardExtensionState`'s own `openOptionsPage`), and closes it whether the load succeeds or
 * throws.
 *
 * @param host - The runtime seam this flow acts through.
 * @param context - The lease session's persistent context the throwaway page belongs to.
 * @param blockerSurfaceUrl - The prepared blocker's own management surface URL.
 * @param expectation - The prepared expectation the payload must express.
 * @returns The complete settings-import JSON document, ready for `applySettingsJson`.
 */
async function buildExtensionSettingsPayloadOverDedicatedPage(
    host: PhaseApplicationFlowHost,
    context: BrowserContext,
    blockerSurfaceUrl: string,
    expectation: ExtensionSettingsPayloadExpectation,
): Promise<string> {
    const page = await context.newPage();
    try {
        await page.goto(blockerSurfaceUrl, { waitUntil: 'load' });
        return await buildExtensionSettingsPayload(page, expectation);
    } finally {
        await page.close().catch((error: unknown) => {
            createLogger({ verbose: host.verbose }).warn(
                { err: error, blockerSurfaceUrl },
                'the settings-payload pre-read page did not close cleanly',
            );
        });
    }
}

/**
 * Render the session-notes fill one application session performs toward.
 *
 * The notes state the boundary truthfully: the launch applies nothing, so this application session
 * is what brings the blocker to the prepared state.
 *
 * @param request - The phase-configuration request naming the phase and the prepared set.
 * @returns Bounded caller notes naming the prepared filter set and the application boundary.
 */
function phaseApplicationNotes(request: EnvironmentPhaseConfigurationRequest): string {
    const prepared = `Prepared filter lists: ${[...request.baselineEnabledFilterIds].join(', ')}`;
    if (request.phase === PhaseLabel.C) {
        return (
            `${prepared}. The candidate rule is the only user rule allowed in the credited ` +
            'state: add it exactly as written and keep the prepared filter set enabled.'
        );
    }
    return (
        `${prepared}. This application session brings the blocker to the prepared state: the ` +
        'launch applies nothing, so plug the prepared baseline back exactly, changing nothing ' +
        'else, and keep no user rule.'
    );
}

/**
 * Read the prepared extension's complete observable state back over one session context.
 *
 * @param host - The runtime seam this flow acts through.
 * @param state - Prepared session naming the verified extension build and the readiness budget.
 * @param context - The session's persistent context.
 * @returns The complete state read plus the enriched read the phase credit compares against.
 */
async function readExtensionBlockerState(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    context: BrowserContext,
): Promise<EnvironmentBlockerStateCapture> {
    const extension = state.extension!;
    const readState = host.readAdGuardExtensionState ?? readAdGuardExtensionStateDefault;
    const stateRead = await readState(
        context,
        extension.manifestVersion,
        host.phaseReadinessBudgetMs === undefined
            ? undefined
            : { budgetMs: host.phaseReadinessBudgetMs },
    );
    return {
        stateRead,
        enriched: {
            rulesContent: stateRead.userRules.content,
            rulesContentSha256: stateRead.userRules.contentSha256,
            // The options metadata is the enabled-set source of truth the read-back credits
            // against; the MV3 counters name the DNR rulesets that actually compiled. Both native
            // numeric sets convert to list keys here, at the reader boundary.
            enabledFilterIds: stateRead.optionsEnabledFilterIds.map(adguardListKey),
            ...(stateRead.rulesLimits
                ? {
                      activeRulesetFilterIds:
                          stateRead.rulesLimits.actuallyEnabledFilters.map(adguardListKey),
                  }
                : {}),
            // The requested/options credit alone proves a filter is switched on, never that its
            // MV3 ruleset actually compiled and activated within the browser's limits — the phase
            // credit in phase-application-procedure.ts requires both before it applies.
            limitsExceeded: filterLimitsExceededFor(stateRead),
            stealthEnabled:
                stateRead.optionsData.settings.values[DISABLE_STEALTH_SETTING] === false,
        },
    };
}

/**
 * Run one application pass: bounded instruction over a session, then the host read-back.
 *
 * @param host - The runtime seam this flow acts through.
 * @param state - Prepared active session supplying the run's settings context.
 * @param request - Application inputs: phase, target, instruction, and the prepared set.
 * @param goal - The expected blocker state the host read-back is credited against.
 * @param session - The session the application acts over.
 * @param expectedStealthEnabledOverride - Exact Tracking-protection state the prepared expectation
 *   requires; the launch pre-read supplies it for a defaults-plus-required launch.
 * @param filtersMetadataOverride - The filter catalog (with groups) the settings payload's required
 *   groups are computed from; the launch pre-read supplies it for the very first Baseline
 *   application, before `state.extensionBaselineReadBack` exists to fall back on.
 * @returns The mapped configuration result plus the complete state read, when one ran.
 */
export async function runApplication(
    host: PhaseApplicationFlowHost,
    state: AgentRuntimeSessionState,
    request: EnvironmentPhaseConfigurationRequest,
    goal: ApplicationGoal,
    session: IBrowserSession,
    expectedStealthEnabledOverride?: boolean,
    filtersMetadataOverride?: AdGuardExtensionOptionsData['filtersMetadata'],
): Promise<RuntimeApplicationOutcome> {
    const contract = parseRuleApplication(request.application);
    if ('gap' in contract) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: contract.gap,
                detail: contract.detail,
            },
        };
    }
    // The declared file-backed target resolves once, before any model turn: a checkout-relative
    // target that escapes the run's checkout root is a typed refusal here — the target is never
    // read and no application session runs — while an absolute target is honored as-is, as part of
    // the instruction's trusted content (D20).
    const declaredFileTarget = contract.verification.target;
    const fileTargetResolution =
        declaredFileTarget === undefined
            ? undefined
            : resolveBlockerFileTarget(host.filtersPath, declaredFileTarget);
    if (fileTargetResolution !== undefined && 'gap' in fileTargetResolution) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: fileTargetResolution.gap,
                detail: fileTargetResolution.detail,
            },
        };
    }
    const admittedFileTargetPath: string | null =
        fileTargetResolution !== undefined && 'path' in fileTargetResolution
            ? fileTargetResolution.path
            : null;
    const readContext = host.applicationReadContexts.get(session);
    const expectedStealthEnabled =
        expectedStealthEnabledOverride ??
        expectedStealthEnabledFor(state.settingsProfile, state.extensionBaselineReadBack);
    const modelRunner = phaseApplicationModelRunner(host, session, request);
    if (!modelRunner || !readContext) {
        // llm/piRuntime are required run options, so a missing model runner here means the
        // request's deadline already aborted before any turn could start; a session without its
        // context cannot read the blocker state back either way. The detail keeps the phase from
        // guessing which one happened.
        const detail = !modelRunner
            ? 'The application session was aborted before any model turn could start.'
            : 'The lease session carries no persistent extension context to read the blocker state over.';
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Unverified,
                detail,
            },
        };
    }
    const blockerSurfaceUrl = await preparedBlockerSurfaceUrl(host, state, readContext);
    let stateRead: AdGuardExtensionStateRead | undefined;
    // The read-back registry is Decision 1's supply: every method this executor knows how to read
    // is listed here, and the application procedure refuses any declared method with no reader
    // before any model turn. The live extension state is the AdGuard route; the file-backed methods
    // read the exact state the instruction's preparation and application steps maintain, with the
    // checkout-root-relative target resolved where the instruction loader's base already sits.
    const declaredFileStateReader = fileBlockerStateReader();
    /**
     * Read one declared file-backed blocker state back over the resolved target.
     *
     * A declared file-backed method always carries a target — the parser refuses a declaration
     * without one — and that target was already resolved to `admittedFileTargetPath` before any
     * model turn, with a containment gap refusing the application long before this reader could
     * run. Both are certainties by the time this reader is ever called; a null path here would mean
     * one of those guarantees broke, so it fails loudly instead of guessing a fallback.
     *
     * @param declaration - The parsed verification declaration carrying the method exactly as the
     *   instruction wrote it.
     * @returns The read-back state the phase credit compares against.
     */
    const readResolvedFileState: BlockerStateReader = async (declaration) => {
        assertApplicationNotAborted(request);
        if (admittedFileTargetPath === null) {
            throw new Error(
                `The "${declaration.method}" verification reached its read-back with no ` +
                    'resolved target path; the parser and the containment check both guarantee one.',
            );
        }
        return declaredFileStateReader({
            method: declaration.method,
            target: admittedFileTargetPath,
        });
    };
    // The settings payload is the Extension's own configuration document, whose
    // `filters.enabled-filters` key speaks registry numbers, while the prepared request set speaks
    // list keys. The keys the request carries were built by `adguardListKey`, so a key this runtime
    // cannot name is a wiring fault rather than a state to guess at.
    const preparedRegistryIds = request.baselineEnabledFilterIds.map((key) => {
        const registryId = parseAdguardListKey(key);
        if (registryId === null) {
            throw new Error(
                `The prepared baseline list key "${key}" is not an AdGuard registry key, so the ` +
                    'Extension settings payload cannot be built.',
            );
        }
        return registryId;
    });
    // The very first Baseline application runs before state.extensionBaselineReadBack exists — it
    // IS what populates it, after this call returns — so the launch's own pre-read supplies the
    // filter catalog then; every later phase (every experiment's B/C) falls back to the baseline
    // read-back buildBrowserExtensionEnvironmentOptions already required to exist.
    const filtersMetadata =
        filtersMetadataOverride ?? state.extensionBaselineReadBack?.optionsData.filtersMetadata;
    if (filtersMetadata === undefined) {
        throw new Error(
            "No filter catalog is available to compute the settings payload's required " +
                'groups: neither a launch pre-read nor a baseline read-back has run yet.',
        );
    }
    const requiredGroupIds = requiredExtensionGroupIds(preparedRegistryIds, filtersMetadata);
    // No model turn has run yet, so the session's own page can be anywhere — this pre-read cannot
    // depend on it. It loads and mutates the export over a dedicated page instead, exactly like
    // every other host read-back of the blocker state (readAdGuardExtensionState/openOptionsPage),
    // never the model's own page.
    const settingsPayload =
        blockerSurfaceUrl === undefined
            ? undefined
            : await buildExtensionSettingsPayloadOverDedicatedPage(
                  host,
                  readContext,
                  blockerSurfaceUrl,
                  {
                      enabledFilterIds: preparedRegistryIds,
                      requiredGroupIds,
                      ...(expectedStealthEnabled === undefined
                          ? {}
                          : { stealthEnabled: expectedStealthEnabled }),
                  },
              );
    const result = await runPhaseApplication({
        application: request.application,
        goal,
        session: {
            targetUrl: request.targetUrl,
            ...(blockerSurfaceUrl === undefined ? {} : { blockerSurfaceUrl }),
            baselineEnabledFilterIds: [...request.baselineEnabledFilterIds],
            ...(expectedStealthEnabled === undefined
                ? {}
                : { expectStealthEnabled: expectedStealthEnabled }),
            settingsPayload,
            notes: phaseApplicationNotes(request),
        },
        modelRunner,
        readBack: {
            [BlockerVerificationMethod.ExtensionState]: async () => {
                assertApplicationNotAborted(request);
                const captured = await readExtensionBlockerState(host, state, readContext);
                stateRead = captured.stateRead;
                return captured.enriched;
            },
            [BlockerVerificationMethod.UserRulesFile]: readResolvedFileState,
            [BlockerVerificationMethod.ManagedStorageFile]: readResolvedFileState,
        },
        signal: request.signal,
    });
    if (result.kind === PhaseApplicationOutcomeKind.Applied) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Applied,
                method: contract.verification.method,
                readBack: result.readBack,
                actionLog: result.actionLog,
                ...(result.detail === undefined ? {} : { detail: result.detail }),
            },
            ...(stateRead ? { stateRead } : {}),
        };
    }
    if (result.kind === PhaseApplicationOutcomeKind.Refused) {
        return {
            result: {
                kind: EnvironmentPhaseConfigurationOutcome.Refused,
                gap: result.gap,
                detail: result.detail,
            },
            ...(stateRead ? { stateRead } : {}),
        };
    }
    return {
        result: {
            kind: EnvironmentPhaseConfigurationOutcome.Unverified,
            detail: result.detail,
        },
        ...(stateRead ? { stateRead } : {}),
    };
}

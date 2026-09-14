import type { BrowserContext } from 'playwright-core';
import type { AdGuardExtensionStateRead } from '../browser/adguard-extension-state-shapes';
import type {
    readAdGuardExtensionState as readAdGuardExtensionStateDefault,
} from '../browser/adguard-extension-state-read';
import type {
    findExtensionRuntime as findExtensionRuntimeDefault,
} from '../browser/extension-runtime-location';
import type { IBrowserSession } from '../browser/browser-interfaces';
import type {
    EnvironmentPhaseConfigurationResult,
    EnvironmentPhaseStateRead,
} from '../environment/browser-extension-environment';
import { PromptDocumentName, createPromptDocumentLoader } from '../prompts/prompt-documents';
import type { LoadedInstruction } from '../knowledge/instruction-loader';
import type { LlmConfig } from '../config/config';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { Logger } from '../logger/logger';
import type { PhaseApplicationModelRunner } from '../validator/phase-application-contract';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { PolicySessionRelaunch } from '../browser/prepared-extension-launch';

/**
 * The host and dependency contracts `phase-application-flow.ts`'s `runApplication` acts through:
 * what the caller must supply (the run's leaf options and dependency overrides, narrowed to exactly
 * what the flow needs) and what one application call returns. Declared once here so the flow module
 * stays focused on the procedure itself.
 */

/**
 * Dependencies of one injected `PhaseApplicationModelRunnerFactory` call.
 */
export interface PhaseApplicationModelRunnerDependencies {
    /**
     * The run's pi runtime, when already built.
     */
    runtime?: PiRuntime;

    /**
     * The run's validated LLM configuration, when carried.
     */
    llm?: LlmConfig;

    /**
     * Run trace recorder every application turn lands in.
     */
    recorder: TraceRecorder;

    /**
     * The session whose page the application tools act on.
     */
    session: IBrowserSession;

    /**
     * Canonical reported origin for the read tools' network inventory.
     */
    allowedOrigin: string;

    /**
     * Application logger.
     */
    logger?: Logger;

    /**
     * The run's usage collector, when the caller supplied one: the application session's usage
     * lands in the same summary as every other session of the run.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Factory for the bounded application-session runner behind every between-phases application.
 *
 * Defaults to the shared pi mode-session runner, which requires the run's pi runtime and LLM
 * configuration; an injected factory (tests) may close over its own inputs and receives whatever
 * the run carries, so the application procedure is observable without a model.
 *
 * @param depends - The run's pi runtime, LLM configuration, recorder, lease session, origin, and
 *   usage collector.
 * @returns The bounded application-session runner.
 */
export type PhaseApplicationModelRunnerFactory = (
    depends: PhaseApplicationModelRunnerDependencies,
) => PhaseApplicationModelRunner;

/**
 * The runtime seam the between-phases application flow acts through: the run's leaf options and
 * dependency overrides, narrowed to exactly what this flow needs.
 */
export interface PhaseApplicationFlowHost {
    /**
     * The run's checkout root a declared file-backed verification target resolves against.
     */
    filtersPath: string;

    /**
     * Persistent browser contexts registered per lease session for the extension-state read-back.
     * Shared by reference with the runtime's own phase-session bootstrap, so a context registered
     * there is visible here without a getter/setter round trip.
     */
    applicationReadContexts: WeakMap<IBrowserSession, BrowserContext>;

    /**
     * Validated LLM provider configuration the bounded application sessions are launched with.
     */
    llm: LlmConfig;

    /**
     * The run's pi runtime reused for the bounded application sessions.
     */
    piRuntime: PiRuntime;

    /**
     * Run trace recorder every application turn lands in.
     */
    recorder: TraceRecorder;

    /**
     * Run-scoped usage collector shared with every model session of the run, when the run carries
     * one.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Whether verbose lifecycle logging is enabled.
     */
    verbose: boolean;

    /**
     * The run instruction loaded at run start, when this run carries one. A run without one applies
     * the built-in AdGuard instruction.
     */
    instruction?: LoadedInstruction;

    /**
     * Wall-clock budget override for the bounded extension-state readiness waits.
     */
    phaseReadinessBudgetMs?: number;

    /**
     * Relaunch one phase session with rebuilt Firefox enterprise policies.
     *
     * The host-performed file-backed application (31-AFK Decision 3) writes the declared file and
     * then needs a browser that reads the rebuilt policies, which Firefox does only at startup. The
     * runtime implements this over the same session factory every other session of the run uses, so
     * a test drives the relaunch through its own injected factory.
     */
    relaunchPolicySession: PolicySessionRelaunch;

    /**
     * Injected application-session runner factory (tests); defaults to the shared pi mode-session
     * runner when absent.
     */
    createPhaseApplicationModelRunner?: PhaseApplicationModelRunnerFactory;

    /**
     * Injected extension-runtime locator (tests); defaults to the production search.
     */
    findExtensionRuntime?: typeof findExtensionRuntimeDefault;

    /**
     * Injected extension-state reader (tests); defaults to the production message-transport read.
     */
    readAdGuardExtensionState?: typeof readAdGuardExtensionStateDefault;
}

/**
 * The application instruction whose contract every between-phases application performs.
 *
 * A run carrying an instruction applies exactly that instruction; a run without one applies the
 * shipped built-in AdGuard document — the converted options-page driver.
 *
 * @param instruction - The run instruction loaded at run start, when this run carries one.
 * @returns The run's application instruction content.
 */
export function applicationInstructionContent(instruction: LoadedInstruction | undefined): string {
    if (instruction) {
        return instruction.content;
    }
    return createPromptDocumentLoader().read(PromptDocumentName.InstructionsAdguardExtension);
}

/**
 * One application run's outcome: the adapter-seam result plus the host's full state read.
 */
export interface RuntimeApplicationOutcome {
    /**
     * The mapped configuration result the adapter seam and the launch gate consume.
     */
    result: EnvironmentPhaseConfigurationResult;

    /**
     * The complete blocker state the host read back itself, when a read ran.
     */
    stateRead?: AdGuardExtensionStateRead;
}

/**
 * One read-back call of a between-phases application: the host's full state read plus the enriched
 * read the procedure compares against.
 */
export interface EnvironmentBlockerStateCapture {
    /**
     * The complete extension state as the state read reported it.
     */
    stateRead: AdGuardExtensionStateRead;

    /**
     * The enriched read mapped onto the adapter's phase-credit shape.
     */
    enriched: EnvironmentPhaseStateRead;
}

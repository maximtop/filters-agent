/**
 * The AdGuard CLI proxy filtering executor: the desktop-shaped executor a run opts into by name.
 *
 * Importing this module performs the registration. The module owns the shape of the executor's
 * preparation boundary (`AdguardCliInstallationHost`) and the proxied evidence-browser route
 * factory; each run wires its own instances through
 * `ExecutorActivationContext.executorDependencies` (keyed by {@link AdguardCliExecutorName}), never
 * through module state — module state would leak one run's host into a concurrently running one,
 * which is exactly how a `backlog` run that never called the old module-state setter always found
 * the sandbox unprovided even with the binary configured. A run that wires no dependencies for this
 * name takes the host-absent path and records the SandboxReservationFailed preparation limitation —
 * the same typed outcome a run without the binary reached before this split.
 */
import {
    EnvironmentCapability,
    EnvironmentPreparationState,
    FilteringEnvironmentAvailability,
    type EnvironmentSelectionSnapshot,
    type FilteringEnvironmentDescriptor,
} from '../environment/environment-selection';
import type { ExecutorPreparationOutcome } from '../environment/executor-preparation';
import type { EvidenceRouteHost } from '../local/evidence-route-contract';
import type {
    ExecutorActivationContext,
    ExecutorAdapterContext,
    FilteringExecutor,
} from '../orchestrator/filtering-executors';
import { filteringExecutors } from '../orchestrator/filtering-executors';
import { readReporterFilterSelection } from '../local/reporter-filters';
import {
    ADGUARD_CLI_PRODUCT,
    describeProvenanceVersion,
    isAdguardCliBuildProvenance,
    type AdguardCliInstallationHost,
    type AdguardCliPreparationOutcome,
    type AdguardCliInstallationProvenance,
    type PreparedAdguardCliInstallation,
} from './adguard-cli-installation';
import { AdguardCliEnvironmentAdapter } from './adguard-cli-environment';
import { AdguardCliExecutorName } from './executor-name';
import {
    AdguardCliPreparationLimitationCode,
    AdguardCliPreparationStage,
} from './adguard-cli-preparation-limitation';

export { AdguardCliExecutorName } from './executor-name';

/**
 * Model-facing routing prose for the proxy executor, contributed to the select_environment
 * description when the executor is available.
 */
const SELECTION_GUIDANCE =
    'An ordinary AdGuard for Windows/Mac (or CLI) website-filtering report belongs to ' +
    'adguard_cli — desktop apps filter network traffic themselves, not through a browser ' +
    'extension. Website-filtering reports from AdGuard mobile apps (iOS/Android) also belong to ' +
    'adguard_cli: the fix ships in shared filter lists, so validate at network level and ' +
    'record the mobile execution-model gap (for example Safari content-blocker syntax limits) as ' +
    'a conflict. An activated adguard_cli selection browses through the filtering proxy for ' +
    'live evidence and applies exactly one candidate rule beside the locked baseline through ' +
    'apply_rule verification phases. Launch every evidence-browser session with ' +
    'extension:"none": the proxy already filters network traffic and there is no extension to ' +
    'prepare. Never claim that the reported desktop app, its platform, or the reporter browser ' +
    'actually ran.';

/**
 * Trusted post-selection facts the evidence-route factory receives.
 */
export interface AdguardCliRouteLifecycleContext {
    /**
     * Locked proxy environment selection after non-spawning preparation.
     */
    environmentSelection: EnvironmentSelectionSnapshot;

    /**
     * First trusted issue target URL retained for conservative recovery.
     */
    targetUrl: string;

    /**
     * Official filter identifiers the reporter had enabled, possibly empty.
     */
    reporterFilterIds: readonly number[];
}

/**
 * Factory that adopts one prepared installation into a proxied evidence-browser route, or refuses
 * the installation. A refused route keeps the run capability-limited instead of demanding a
 * licensed product CLI.
 */
export type AdguardCliEvidenceRouteFactory = (
    installation: PreparedAdguardCliInstallation,
    provenance: AdguardCliInstallationProvenance,
    context: AdguardCliRouteLifecycleContext,
) => EvidenceRouteHost | null;

/**
 * Preparation-boundary dependencies a run wires into this executor.
 */
export interface AdguardCliExecutorDependencies {
    /**
     * Automatic proxy preparation boundary, when this cycle provides one.
     */
    installationHost?: AdguardCliInstallationHost;

    /**
     * Proxied evidence-browser route factory, when this cycle provides one.
     */
    createEvidenceRoute?: AdguardCliEvidenceRouteFactory;
}

/**
 * Read this run's AdGuard CLI dependencies from its activation context.
 *
 * The bag is opaque to `src/`, so the cast back to this module's own shape is a same-process,
 * self-authored read, not an external trust boundary: this module is both the sole writer (every
 * caller that populates the {@link AdguardCliExecutorName} key does so with exactly this shape) and
 * the sole reader of that key.
 *
 * @param context - The run's activation context.
 * @returns This run's wired dependencies, or an empty object for a run that wired none.
 */
function runAdguardCliExecutorDependencies(
    context: ExecutorActivationContext,
): AdguardCliExecutorDependencies {
    return (
        (context.executorDependencies?.[AdguardCliExecutorName] as
            | AdguardCliExecutorDependencies
            | undefined) ?? {}
    );
}

/**
 * Build the proxy executor's capability descriptor: a preparable executor advertising only the
 * installation and activation capabilities before its evidence route is ready.
 *
 * @returns Fresh descriptor for the adguard_cli executor.
 */
function adguardCliExecutorDescriptor(): FilteringEnvironmentDescriptor {
    return {
        kind: AdguardCliExecutorName,
        availability: FilteringEnvironmentAvailability.Available,
        preparationState: EnvironmentPreparationState.Preparable,
        limitationCode: null,
        capabilities: [EnvironmentCapability.CliInstallation, EnvironmentCapability.CliActivation],
    };
}

/**
 * RFC 4648 base32 alphabet. The published digest uses base32 rather than hex so the durable
 * provenance is visibly a bounded token rather than a raw hash channel.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a lowercase hex SHA-256 digest as canonical (unpadded) base32.
 *
 * @param hexDigest - Verified lowercase hex digest of the prepared binary.
 * @returns Deterministic unpadded base32 token for the published provenance.
 */
function digestToB32(hexDigest: string): string {
    const bytes = Buffer.from(hexDigest, 'hex');
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        // A digest's 256 bits are a whole 32-bit cell; the character below exists only for
        // inputs whose length is not a multiple of five bytes.
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

/**
 * Project one trusted preparation outcome into the durable path-free outcome the selection host
 * binds. The opaque installation capability stays out of the published record: the report names
 * what the run honestly executed, nothing more.
 *
 * @param outcome - Ready installation plus provenance, or a stable stage limitation.
 * @returns Durable executor-preparation outcome over path-free bounded provenance.
 */
function toExecutorPreparationOutcome(
    outcome: AdguardCliPreparationOutcome,
): ExecutorPreparationOutcome {
    if (!outcome.ready) {
        return {
            ready: false,
            limitation: {
                stage: outcome.limitation.stage,
                code: outcome.limitation.code,
                detail: outcome.limitation.detail,
            },
        };
    }
    const provenance = outcome.provenance;
    return {
        ready: true,
        provenance: {
            source: isAdguardCliBuildProvenance(provenance)
                ? provenance.source
                : 'official_release',
            product: ADGUARD_CLI_PRODUCT,
            version: describeProvenanceVersion(provenance),
            digestB32: digestToB32(provenance.binarySha256),
        },
    };
}

/**
 * Serve the Reserve-stage SandboxReservationFailed limitation the pipeline records when no private
 * proxy sandbox was provided or the preparation attempt crashed.
 *
 * @param detail - Fixed host-authored sentence naming the failure classification.
 * @returns The typed preparation limitation.
 */
function sandboxReservationFailure(detail: string): AdguardCliPreparationOutcome {
    return {
        ready: false,
        limitation: {
            stage: AdguardCliPreparationStage.Reserve,
            code: AdguardCliPreparationLimitationCode.SandboxReservationFailed,
            detail,
        },
    };
}

export const adguardCliFilteringExecutor: FilteringExecutor = {
    name: AdguardCliExecutorName,
    descriptor: adguardCliExecutorDescriptor(),
    selectionGuidance: SELECTION_GUIDANCE,

    /**
     * Run the proxy executor's preparation and evidence-route pipeline for the locked selection.
     *
     * @param context - Locked selection host, run facts, and the runtime host.
     */
    async activate(context: ExecutorActivationContext): Promise<void> {
        const host = context.environmentHost;
        const snapshot = host.snapshot();
        // Preparation runs only for a locked proxy selection whose reported filter selection has
        // an executable official baseline: the host has already degraded every other case, and
        // preparing a route would bind evidence to a baseline that cannot execute.
        if (
            snapshot === null ||
            snapshot.selectedKind !== AdguardCliExecutorName ||
            snapshot.filterBaseline?.status !== 'executable'
        ) {
            return;
        }
        const dependencies = runAdguardCliExecutorDependencies(context);
        const preparation: AdguardCliPreparationOutcome =
            await prepareProxyInstallation(dependencies);
        if (preparation.ready) {
            await adoptEvidenceRoute(host, context, preparation.provenance, dependencies);
        }
        host.attachExecutorPreparation(toExecutorPreparationOutcome(preparation));
    },

    /**
     * Build the executing proxy adapter from the run's activated evidence route.
     *
     * @param context - Runtime-resolved adapter inputs and the session-launch seam.
     * @returns Fresh executing adapter bound to the run's isolated installation.
     */
    createAdapter(context: ExecutorAdapterContext): AdguardCliEnvironmentAdapter {
        const route = context.evidenceRoute;
        if (route === null) {
            throw new Error('The proxy executor executes only from an activated evidence route.');
        }
        const ports = route.environmentPorts();
        return new AdguardCliEnvironmentAdapter({
            cliVersion: ports.cliVersion,
            product: ports.product,
            installationDigest: ports.installationDigest,
            baselineHost: ports.baselineHost,
            applyCandidate: (rule) => ports.applyCandidate(rule),
            revokeCandidate: () => ports.revokeCandidate(),
            createSession: async (request) => {
                return await context.launchEvidenceSession({ targetUrl: request.targetUrl });
            },
        });
    },
};

/**
 * Prepare one private proxy installation through the wired boundary.
 *
 * The host-absent path records the same SandboxReservationFailed limitation a live run reached when
 * the binary was absent, so a run without the boundary runs hermetically instead of crashing.
 *
 * @param dependencies - This run's wired AdGuard CLI dependencies.
 * @returns Ready installation capability, or a stable stage-bound limitation.
 */
async function prepareProxyInstallation(
    dependencies: AdguardCliExecutorDependencies,
): Promise<AdguardCliPreparationOutcome> {
    if (dependencies.installationHost === undefined) {
        return sandboxReservationFailure(
            'A private AdGuard CLI proxy sandbox was not provided by the Host.',
        );
    }
    try {
        return await dependencies.installationHost.prepare();
    } catch (error) {
        // The typed outcome must survive even a crashing preparation boundary; the full error is
        // preserved here before it is mapped away.
        console.error('adguard cli proxy preparation failed', error);
        return sandboxReservationFailure('Automatic AdGuard CLI proxy preparation failed safely.');
    }
}

/**
 * Adopt the prepared installation into a proxied evidence-browser route for the run.
 *
 * A transferred capability that fails to configure degrades the run to no route at all — the
 * preparation limitation below still lands, and the run keeps its typed capability-limited
 * outcome.
 *
 * @param host - Locked selection host the outcome binds to.
 * @param context - Activation context with the runtime host and trusted URL.
 * @param provenance - Path-free provenance of the prepared installation.
 * @param dependencies - This run's wired AdGuard CLI dependencies.
 */
async function adoptEvidenceRoute(
    host: ExecutorActivationContext['environmentHost'],
    context: ExecutorActivationContext,
    provenance: AdguardCliInstallationProvenance,
    dependencies: AdguardCliExecutorDependencies,
): Promise<void> {
    if (dependencies.createEvidenceRoute === undefined) {
        return;
    }
    const installation = dependencies.installationHost?.takeReadyInstallation() ?? null;
    if (installation === null) {
        host.attachExecutorPreparation({
            ready: false,
            limitation: {
                stage: AdguardCliPreparationStage.Install,
                code: AdguardCliPreparationLimitationCode.CliInstallationCapabilityUnavailable,
                detail: 'The prepared CLI capability could not be transferred safely.',
            },
        });
        // The ready provenance above is never attached; the limited outcome is the record of
        // record for this run.
        return;
    }
    const environmentSelection = host.snapshot();
    if (environmentSelection === null) {
        host.attachExecutorPreparation({
            ready: false,
            limitation: {
                stage: AdguardCliPreparationStage.Install,
                code: AdguardCliPreparationLimitationCode.CliEnvironmentSelectionUnavailable,
                detail: 'The locked CLI environment selection could not be retained.',
            },
        });
        return;
    }
    const lifecycleContext: AdguardCliRouteLifecycleContext = {
        environmentSelection,
        targetUrl: context.targetUrl,
        reporterFilterIds:
            readReporterFilterSelection(context.issueFacts.settingsImportUrl)?.filterIds ?? [],
    };
    // The engine is the filtering executor itself: no product lifecycle. The AdGuard CLI engine
    // activates and resets its licence inside its own proxy host.
    let evidenceRoute = dependencies.createEvidenceRoute(
        installation,
        provenance,
        lifecycleContext,
    );
    if (evidenceRoute !== null) {
        try {
            // The pinned configuration must exist before the first proxied session so the exact
            // evidence transcript stays free of settings hints.
            await evidenceRoute.prepareConfiguration();
        } catch (error) {
            console.error('adguard-cli evidence route configuration failed', error);
            // The proxy host already released its engine (the CLI licence) when its own
            // preparation failed; stopping the route also covers a failure after that point.
            await evidenceRoute.stop?.().catch((stopError: unknown) => {
                console.error(
                    'adguard-cli evidence route stop after failed configuration',
                    stopError,
                );
            });
            evidenceRoute = null;
        }
    }
    if (evidenceRoute !== null) {
        context.runtime.activateEvidenceRoute(evidenceRoute, lifecycleContext.reporterFilterIds);
    }
}

// Side-effectful registration: importing this module joins the process registry.
filteringExecutors.register(adguardCliFilteringExecutor);

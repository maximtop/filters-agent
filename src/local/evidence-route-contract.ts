import type { Logger } from 'pino';
import type { ReproProfile } from '../types/repro-profile';
import type { BrowserSession } from '../browser/browser-session';

/**
 * The command and storage contract of one isolated filtering installation, pinned by the retired
 * product CLI this baseline contract was written against. The producing route reads the native
 * catalog itself and binds these argv forms; src owns the contract and lab implements it.
 */
export const BASELINE_ACTION_CONTRACT = Object.freeze({
    cliVersion: '1.4.13',
    actions: Object.freeze([
        'add_filter',
        'enable_filter',
        'disable_filter',
        'list_all_filters',
    ] as const),
});

/**
 * Exact native action the route's baseline port may ask the isolated installation to perform.
 */
export type BaselineHostAction = (typeof BASELINE_ACTION_CONTRACT.actions)[number];

/**
 * Storage and command boundary the executing adapter drives on one isolated installation.
 */
export interface BaselineHostPort {
    /**
     * Run one baseline action and return its complete bounded stdout.
     *
     * @param action - Named baseline action.
     * @param filterId - Pinned official catalog ID, or null for the list action.
     * @returns Bounded stdout; rejects on any nonzero exit, timeout, or output overflow.
     */
    runBaselineAction(action: BaselineHostAction, filterId: number | null): Promise<string>;

    /**
     * List every regular file the installation currently holds under its own data root.
     *
     * @returns Absolute paths, bounded; rejects rather than truncating when the bound is exceeded.
     */
    listStorageFiles(): Promise<readonly string[]>;

    /**
     * Canonical installation data root, used for containment checks and portable relative paths.
     */
    readonly cliDataRoot: string;
}

/**
 * Receipt proving one exact candidate line is the only agent-authored content the installation
 * executes.
 */
export interface CandidateReceipt {
    /**
     * SHA-256 of the exact rule line the agent-authored source holds, without a terminal newline.
     */
    contentDigest: string;

    /**
     * Number of rule lines in that source.
     */
    ruleCount: number;

    /**
     * Number of configured filter sources beyond the official filter manager.
     */
    extraSourceCount: number;
}

/**
 * Stable path-free failure classifications for the CLI evidence route.
 */
export type EvidenceRouteFailureCode =
    | 'configuration_failed'
    | 'foreground_failed'
    | 'route_unavailable'
    | 'browser_launch_failed';

/**
 * Optional cause carrier for an evidence route failure.
 */
interface EvidenceRouteErrorOptions {
    /**
     * The underlying engine or browser error, when one exists.
     */
    cause?: unknown;
}

/**
 * Stable non-echoing failure raised by the evidence route host.
 *
 * The message stays path-free for public evidence; the underlying engine or browser error rides
 * along as `cause` so runtime diagnostics (for example the fatal-signal extraction that classifies
 * deterministic launch crashes) can still read the full chain.
 */
export class EvidenceRouteError extends Error {
    /**
     * Create one path-free evidence route failure.
     *
     * @param code - Stable public failure classification.
     * @param options - Optional cause chain retaining the underlying failure for diagnostics.
     */
    constructor(
        readonly code: EvidenceRouteFailureCode,
        options?: EvidenceRouteErrorOptions,
    ) {
        super(`AdGuard CLI evidence route failed: ${code}.`, options);
        this.name = 'EvidenceRouteError';
    }
}

/**
 * Path-free evidence route lifecycle snapshot retained for run evidence.
 */
export interface EvidenceRouteSnapshot {
    /**
     * Current host state.
     */
    state: 'new' | 'configured' | 'foreground_running' | 'stopped' | 'failed';
    /**
     * Loopback proxy port after the foreground started, or null.
     */
    port: number | null;
    /**
     * Whether the official Base Filter (ID 2) was enabled for the session.
     */
    baseFilterEnabled: boolean;

    /**
     * Official filter identifiers the reporter had enabled and the CLI accepted.
     */
    reproducedFilterIds: readonly number[];

    /**
     * Reporter identifiers the CLI catalog did not accept, kept as an evidence fidelity gap.
     */
    unavailableFilterIds: readonly number[];
    /**
     * First terminal failure classification, or null.
     */
    failureCode: EvidenceRouteFailureCode | null;
}

/**
 * Exact inputs for one proxied evidence browser session.
 */
export interface EvidenceSessionRequest {
    /**
     * Exact locked HTTPS target the session may open.
     */
    targetUrl: string;
    /**
     * Reporter-derived reproduction profile.
     */
    reproProfile: ReproProfile;
    /**
     * Existing artifacts directory for session captures.
     */
    artifactsDir: string;
    /**
     * Headless launch flag.
     */
    headless: boolean;
    /**
     * Chromium sandbox opt-out.
     */
    noSandbox: boolean;
    /**
     * Run logger.
     */
    logger: Logger;
}

/**
 * Command and candidate ports the executing environment adapter drives.
 */
export interface EvidenceRoutePorts {
    /**
     * Exact engine version the adapter binds into its proof, or null when the executing build does
     * not know one.
     */
    cliVersion: string | null;

    /**
     * Exact executing product label the adapter reports as its actual context.
     */
    product: string;

    /**
     * Verified installation provenance digest.
     */
    installationDigest: string;

    /**
     * Bounded command and storage boundary for the isolated installation.
     */
    baselineHost: BaselineHostPort;

    /**
     * Install exactly one agent-authored rule beside the locked official baseline.
     *
     * @param rule - Exact single candidate line.
     * @returns Receipt describing what the isolated installation now executes.
     */
    applyCandidate(rule: string): Promise<CandidateReceipt>;

    /**
     * Remove the agent-authored source, leaving only the locked official baseline.
     */
    revokeCandidate(): Promise<void>;
}

/**
 * Host-owned CLI evidence route: pinned configuration, filtering foreground, and a strict-route
 * browser session whose traffic is filtered by the activated AdGuard CLI proxy.
 */
export interface EvidenceRouteHost {
    /**
     * Write the pinned release configuration before the first licensed CLI command.
     */
    prepareConfiguration(): Promise<void>;
    /**
     * Start the filtering foreground once and launch one proxied evidence browser session.
     *
     * @param request - Exact target, profile, and launch facts.
     * @returns Live browser session owned by the caller.
     */
    launchEvidenceSession(request: EvidenceSessionRequest): Promise<BrowserSession>;
    /**
     * Build the command and candidate ports the common CLI environment adapter drives.
     *
     * Exposed by the route because it already owns the verified installation: the adapter needs the
     * same isolated boundary the evidence sessions run through, not a second one.
     *
     * @returns Ports bound to this run's installation.
     */
    environmentPorts(): EvidenceRoutePorts;

    /**
     * Stop whatever the route itself owns. Idempotent, and absent for routes that own nothing.
     *
     * The AdGuard CLI route implements no teardown: its foreground child is registered with the
     * same-activation lifecycle, which owns terminal stop, reap, and licence reset, and a second
     * path here would race it. A CLI proxy route has no such owner — the proxy is its own process
     * and nothing else will end it — so that route does implement this.
     */
    stop?(): Promise<void>;

    /**
     * Read the path-free route snapshot.
     *
     * @returns Immutable evidence route state.
     */
    snapshot(): EvidenceRouteSnapshot;
}

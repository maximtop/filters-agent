import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserSession } from '../browser/browser-session';
import type { AppliedRulesLog } from '../environment/applied-rules';
import type { Logger } from '../logger/logger';
import { createPreparedStrictBrowserRoute } from '../browser/strict-browser-route';
import type {
    EvidenceRouteHost,
    EvidenceRoutePorts,
    EvidenceRouteSnapshot,
    EvidenceSessionRequest,
} from '../local/evidence-route-contract';
import { EvidenceRouteError } from '../local/evidence-route-contract';
import { probeTlsInterception } from '../local/tls-interception-diagnostic';
import {
    createAdguardCliBaselineHost,
    type AdguardCliBaselineHost,
} from './adguard-cli-baseline-host';
import { createAdguardCliAppliedRulesLog } from './adguard-cli-applied-rules';
import { createAdguardCliBlockedRequests } from './adguard-cli-blocked-requests';
import { watchAdguardCliPageReports } from './adguard-cli-page-reports';
import type { ProxyHost, ProxyHostInput, ProxyLogger } from './proxy-host';
import { ACCESS_LOG_FILENAME, OUTPUT_LOG_FILENAME } from './adguard-cli-proxy-config';
import {
    downloadOfficialFilters,
    type DownloadedOfficialFilter,
} from '../local/official-filter-downloader';

/**
 * Milliseconds a minted evidence route stays consumable before the strict route rejects it.
 */
const EVIDENCE_ROUTE_LIFETIME_MS = 10 * 60_000;

/**
 * Size of one proxy log, zero while the proxy has not written it yet.
 *
 * @param path - The log file.
 * @returns Its size in bytes.
 */
async function logSize(path: string): Promise<number> {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0;
        }
        throw error;
    }
}

/**
 * Construction input for one run-owned AdGuard CLI evidence route.
 */
export interface CreateAdguardCliEvidenceRouteHostInput {
    /**
     * Exact cycle identity, retained for route binding.
     */
    cycleId: string;

    /**
     * Absolute path of the `adguard-cli` executable.
     */
    binaryPath: string;

    /**
     * Engine choice: builds the proxy host for the resolved engine around the route's workspace,
     * filter lists, and logger.
     */
    createProxy: (proxyInput: ProxyHostInput) => ProxyHost;

    /**
     * Logger handed to the proxy so its lifecycle steps and failures reach the run log.
     */
    logger?: ProxyLogger;

    /**
     * Directory the route owns for configuration, filter files, and logs.
     */
    workspaceDir: string;

    /**
     * Directory holding cached official filter lists across runs.
     */
    filterCacheDir: string;

    /**
     * Official filter identifiers the reporter had enabled.
     */
    reporterFilterIds?: readonly number[];

    /**
     * Version the executing context reports, kept equal to the preparation provenance so the
     * selection snapshot stays internally consistent. Null when the engine build knows none.
     */
    cliVersion?: string | null;

    /**
     * Host wall-clock source.
     */
    now?: () => string;

    /**
     * Optional deterministic seams.
     */
    dependencies?: {
        /**
         * Filter list downloader.
         */
        downloadFilters?: typeof downloadOfficialFilters;
        /**
         * Strict-route browser session factory.
         */
        createBrowserSession?: typeof BrowserSession.create;
        /**
         * Interception probe proving whose authority the proxy presents.
         */
        probeInterception?: typeof probeTlsInterception;
        /**
         * Private browser-root reservation.
         */
        reserveBrowserRoot?: () => Promise<string>;
    };
}

/**
 * Create the AdGuard CLI-backed evidence route.
 *
 * It satisfies the same contract as the AdGuard CLI route, so the runtime is unchanged, but it
 * needs no licence, fetches nothing in the background, and executes exactly the filter files the
 * run supplied — which is what makes its baseline attributable and its phases comparable.
 *
 * @param input - Binary, engine choice, workspace, reporter filters, and optional seams.
 * @returns Evidence route host.
 */
export function createAdguardCliEvidenceRouteHost(
    input: CreateAdguardCliEvidenceRouteHostInput,
): EvidenceRouteHost {
    const now = input.now ?? (() => new Date().toISOString());
    const downloadFilters = input.dependencies?.downloadFilters ?? downloadOfficialFilters;
    const createSession = input.dependencies?.createBrowserSession ?? BrowserSession.create;

    let state: EvidenceRouteSnapshot['state'] = 'new';
    let failureCode: EvidenceRouteSnapshot['failureCode'] = null;
    let proxy: ProxyHost | null = null;
    let filters: readonly DownloadedOfficialFilter[] = [];
    let unavailableFilterIds: readonly number[] = [];
    let interception: Awaited<ReturnType<typeof probeTlsInterception>> | null = null;
    let route: Awaited<ReturnType<ProxyHost['start']>> | null = null;
    let baselineHost: AdguardCliBaselineHost | null = null;
    // SHA-256 of the executing proxy binary: the adapter folds the installation identity into its
    // state digest under a pinned sha256 schema, and this is the digest that honestly names the
    // engine build a run executed.
    let binarySha256: string | null = null;

    // The baseline host owns this directory alone. It must not be the proxy workspace: the proxy
    // prepares files named exactly like the ones each baseline add creates, and an add that only
    // overwrites an existing file loses its byte attribution.
    const baselineDataRoot = join(input.workspaceDir, 'baseline');

    const fail = (
        code: NonNullable<EvidenceRouteSnapshot['failureCode']>,
        cause?: unknown,
    ): EvidenceRouteError => {
        state = 'failed';
        failureCode ??= code;
        return new EvidenceRouteError(code, cause === undefined ? undefined : { cause });
    };

    // The lists the proxy executes now: every downloaded list until the baseline host exists,
    // then exactly the subset the current phase enabled through it.
    const executedFilterIds = (): readonly number[] | null =>
        baselineHost === null ? null : baselineHost.enabledFilterIds();

    const reserveBrowserRoot =
        input.dependencies?.reserveBrowserRoot ??
        (async (): Promise<string> => {
            const root = await mkdtemp(join(input.workspaceDir, 'evidence-browser-'));
            await chmod(root, 0o700);
            return root;
        });

    return {
        async prepareConfiguration(): Promise<void> {
            if (proxy) {
                return;
            }
            try {
                await mkdir(input.workspaceDir, { recursive: true, mode: 0o700 });
                await mkdir(baselineDataRoot, { recursive: true, mode: 0o700 });
                binarySha256 = createHash('sha256')
                    .update(await readFile(input.binaryPath))
                    .digest('hex');
                // Base is always present: an unfiltered baseline would make every phase
                // meaningless, and the reporter's own selection is layered on top of it.
                const requested = [...new Set([2, ...(input.reporterFilterIds ?? [])])].sort(
                    (left, right) => left - right,
                );
                const downloaded = await downloadFilters(requested, input.filterCacheDir);
                filters = downloaded.filters;
                unavailableFilterIds = downloaded.unavailableFilterIds;
                if (filters.length === 0) {
                    throw fail('configuration_failed');
                }
                proxy = input.createProxy({
                    binaryPath: input.binaryPath,
                    workspaceDir: input.workspaceDir,
                    logger: input.logger,
                    filterLists: filters.map((filter) => ({
                        filterId: filter.filterId,
                        content: filter.content,
                    })),
                });
                await proxy.prepare();
                state = 'configured';
            } catch (error) {
                if (error instanceof EvidenceRouteError) {
                    throw error;
                }
                throw fail('configuration_failed', error);
            }
        },

        async launchEvidenceSession(request: EvidenceSessionRequest) {
            const host = proxy;
            if (!host) {
                throw fail('route_unavailable');
            }
            try {
                // The session must ride a proxy executing exactly the filters the current phase
                // enabled through the baseline host — bookkeeping alone would leave a control
                // phase filtered by the whole baseline. Before any baseline exists, every
                // downloaded list runs.
                const restarted = await host.setEnabledFilters(executedFilterIds());
                if (restarted !== null && route !== null) {
                    route = restarted;
                    request.logger.info(
                        { proxyPort: route.port },
                        'adguard-cli evidence route reconciled to the enabled filter set',
                    );
                }
                if (route === null) {
                    route = await host.start();
                    state = 'foreground_running';
                    request.logger.info(
                        {
                            proxyPort: route.port,
                            filterIds: filters.map((filter) => filter.filterId),
                            unavailableFilterIds,
                        },
                        'adguard-cli evidence route started',
                    );
                }
            } catch (error) {
                // The public code is finite, but the proxy's own failure detail is the only thing
                // that makes a foreground start diagnosable — log it before collapsing.
                request.logger.info(
                    {
                        error: error instanceof Error ? error.message : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    'adguard-cli evidence route foreground start failed',
                );
                throw fail('foreground_failed', error);
            }
            const certificate = route;
            if (!interception) {
                // Same proof the CLI route needs: the proxy presents a leaf alone, so the browser
                // can only accept it once the Host has verified the leaf is signed by this run's
                // own authority.
                const probe = input.dependencies?.probeInterception ?? probeTlsInterception;
                interception = await probe(
                    certificate.proxyUrl,
                    request.targetUrl,
                    certificate.certificateDerBase64,
                ).catch(() => null);
                request.logger.info(
                    {
                        outcome: interception?.outcome,
                        leafIssuedByExpectedCa: interception?.leafIssuedByExpectedCa,
                    },
                    'adguard-cli evidence route interception probe',
                );
            }
            try {
                const browserRoot = await reserveBrowserRoot();
                const certificateDer = Buffer.from(certificate.certificateDerBase64, 'base64');
                const authority = new X509Certificate(certificateDer);
                const strictRoute = createPreparedStrictBrowserRoute({
                    routeId: randomUUID(),
                    cycleId: input.cycleId,
                    targetUrl: request.targetUrl,
                    proxyUrl: certificate.proxyUrl,
                    spkiSha256Base64: createHash('sha256')
                        .update(authority.publicKey.export({ type: 'spki', format: 'der' }))
                        .digest('base64'),
                    certificateDerBase64: certificate.certificateDerBase64,
                    certificateSha256: createHash('sha256').update(certificateDer).digest('hex'),
                    browserRoot,
                    expiresAt: new Date(
                        Date.parse(now()) + EVIDENCE_ROUTE_LIFETIME_MS,
                    ).toISOString(),
                });
                const { CloakBrowserEngine } = await import('../browser/cloakbrowser-engine');
                const accessLogPath = join(input.workspaceDir, ACCESS_LOG_FILENAME);
                return await createSession({
                    engine: new CloakBrowserEngine(),
                    logger: request.logger,
                    reproProfile: request.reproProfile,
                    artifactsDir: request.artifactsDir,
                    headless: request.headless,
                    noSandbox: request.noSandbox,
                    strictRoute,
                    strictRouteTargetUrl: request.targetUrl,
                    strictRouteAcceptProxyAuthority: interception?.leafIssuedByExpectedCa === true,
                    engineBlockedRequests: createAdguardCliBlockedRequests(
                        accessLogPath,
                        await logSize(accessLogPath),
                    ),
                });
            } catch (error) {
                if (error instanceof EvidenceRouteError) {
                    throw error;
                }
                // The public code is finite; the underlying browser or route-construction error
                // is only diagnosable from the run log, so it is recorded before collapsing.
                // The wrapper message is fixed prose; everything diagnosable — the engine's own
                // failure and its stack — lives in `cause`, so unwrap the whole chain.
                const chain: string[] = [];
                for (let current: unknown = error; current; ) {
                    chain.push(
                        current instanceof Error
                            ? `${current.name}: ${current.message}`
                            : String(current),
                    );
                    current = current instanceof Error ? current.cause : null;
                }
                request.logger.info(
                    {
                        error: chain.join(' <- '),
                        stack: error instanceof Error ? error.stack : undefined,
                    },
                    'adguard-cli evidence session launch failed',
                );
                throw fail('browser_launch_failed', error);
            }
        },

        environmentPorts(): EvidenceRoutePorts {
            const host = proxy;
            if (!host) {
                throw fail('route_unavailable');
            }
            baselineHost ??= createAdguardCliBaselineHost({
                dataRoot: baselineDataRoot,
                filters,
                acquiredAt: now(),
            });
            return {
                cliVersion: input.cliVersion ?? null,
                product: 'AdGuard CLI',
                installationDigest: binarySha256!,
                baselineHost,
                applyCandidate: async (rule) => {
                    route = await host.setUserRules([rule]);
                    return {
                        contentDigest: createHash('sha256').update(rule).digest('hex'),
                        ruleCount: 1,
                        extraSourceCount: 1,
                    };
                },
                revokeCandidate: async () => {
                    route = await host.setUserRules([]);
                },
            };
        },

        async openAppliedRulesLog(
            session: BrowserSession,
            logger: Logger,
        ): Promise<AppliedRulesLog> {
            const running = route;
            if (running === null) {
                throw new Error(
                    'The applied-rules log opened with no proxy running, yet a session launches ' +
                        'on this route only after it starts the proxy.',
                );
            }
            const accessLogPath = join(input.workspaceDir, ACCESS_LOG_FILENAME);
            const outputLogPath = join(input.workspaceDir, OUTPUT_LOG_FILENAME);
            const executed = executedFilterIds();
            return createAdguardCliAppliedRulesLog({
                accessLogPath,
                outputLogPath,
                accessLogOffset: await logSize(accessLogPath),
                outputLogOffset: await logSize(outputLogPath),
                lists: filters.filter(
                    (filter) => executed === null || executed.includes(filter.filterId),
                ),
                page: watchAdguardCliPageReports(session.getPage(), logger),
                // Every start and restart hands back a new route, so identity is the restart signal.
                stillCurrent: () => route === running,
            });
        },

        async stop(): Promise<void> {
            await proxy?.stop();
            route = null;
        },

        snapshot(): EvidenceRouteSnapshot {
            const proxySnapshot = proxy?.snapshot();
            return {
                state: proxySnapshot?.state === 'stopped' ? 'stopped' : state,
                port: proxySnapshot?.port ?? null,
                baseFilterEnabled: filters.some((filter) => filter.filterId === 2),
                reproducedFilterIds: filters
                    .map((filter) => filter.filterId)
                    .filter((filterId) => filterId !== 2),
                unavailableFilterIds: [...unavailableFilterIds],
                failureCode,
            };
        },
    };
}

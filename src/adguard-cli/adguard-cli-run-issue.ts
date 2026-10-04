/**
 * The per-issue engine of a run that enables the AdGuard CLI executor: the shared public
 * `runDefaultSingleIssue` composition, unchanged, with the AdGuard CLI proxy's installation host
 * and evidence-route factory wired into every issue's own investigation through
 * `FixCoreOptions.agentRuntime.executorDependencies`. Without this wiring a locked `adguard_cli`
 * selection finds no sandbox provided — even with the binary configured — and ends
 * capability-limited. Every other behavior — workspace preparation, GitHub publication, the durable
 * revision marker — stays exactly the public engine's own; only the investigation seam is wrapped.
 * The action and the lab CLI build their `runIssue` seam here, so the two never drift.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { runDefaultSingleIssue } from '../entry/single-issue-run';
import type {
    DefaultSingleIssueRequest,
    DefaultSingleIssueResult,
} from '../entry/single-issue-run-types';
import { extractReport } from '../intake/extract-report';
import { runFixCore } from '../orchestrator/fix-core';
import { createAdguardCliInstallationHost } from './adguard-cli-preparer';
import { AdguardCliSandboxCleanupStatus } from './adguard-cli-installation';
import { AdguardCliExecutorName } from './executor-name';
import {
    resolveDesktopEngine,
    createProductionEvidenceRouteFactory,
    reservePrivateCliCycleRoot,
} from './run-wiring';

/**
 * Injectable seams of the backlog's AdGuard CLI-wired per-issue engine; production passes nothing.
 */
export interface AdguardCliRunIssueDependencies {
    /**
     * Per-issue investigation seam; production composes the shared public engine.
     */
    runDefaultSingleIssue?: typeof runDefaultSingleIssue;

    /**
     * AdGuard CLI installation-host factory; production builds a fresh host per issue.
     */
    createAdguardCliInstallationHost?: typeof createAdguardCliInstallationHost;

    /**
     * Private CLI root reservation; production reserves a fresh mode-0700 temp root per issue.
     */
    reservePrivateCliCycleRoot?: typeof reservePrivateCliCycleRoot;

    /**
     * GitHub-independent investigation core; production investigates through runFixCore.
     */
    runFixCore?: typeof runFixCore;
}

/**
 * Build the per-issue `runIssue` seam: the shared public engine, with the AdGuard CLI proxy's
 * per-run dependencies wired into every issue's own investigation so a locked `adguard_cli`
 * selection activates against this run's AdGuard CLI configuration instead of degrading to its
 * unreachable-sandbox limitation. Each issue gets its own private CLI root and installation host,
 * so two issues running back to back in the same backlog invocation never share sandbox state.
 *
 * @param workspaceRoot - Canonical agent workspace root the evidence-route factory caches under.
 * @param env - Raw process environment naming the configured AdGuard CLI binary, when any.
 * @param dependencies - Injectable seams; production passes nothing.
 * @returns The per-issue seam bound to this run's AdGuard CLI wiring.
 */
export function createAdguardCliRunIssue(
    workspaceRoot: string,
    env: Record<string, string | undefined>,
    dependencies: AdguardCliRunIssueDependencies = {},
): (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult> {
    const runIssue = dependencies.runDefaultSingleIssue ?? runDefaultSingleIssue;
    const createInstallationHost =
        dependencies.createAdguardCliInstallationHost ?? createAdguardCliInstallationHost;
    const reservePrivateRoot =
        dependencies.reservePrivateCliCycleRoot ?? reservePrivateCliCycleRoot;
    const investigateCore = dependencies.runFixCore ?? runFixCore;
    const desktopEngine = resolveDesktopEngine(env);
    const createEvidenceRoute = createProductionEvidenceRouteFactory(workspaceRoot, desktopEngine);

    return async (request: DefaultSingleIssueRequest): Promise<DefaultSingleIssueResult> => {
        // The reservation resolves every forbidden root, and the action hands over an artifacts
        // path the entry has not created yet; creating it here, with the entry's own mode, lets
        // the overlap check see it.
        mkdirSync(request.artifactsDir, { recursive: true, mode: 0o700 });
        const privateCycleRoot = reservePrivateRoot([workspaceRoot, request.artifactsDir]);
        const installationHost = createInstallationHost({
            privateCycleRoot,
            binaryPath: desktopEngine?.binaryPath ?? null,
        });
        try {
            return await runIssue(request, {
                extractReport,
                investigate: (config, issue, options, coreDependencies) =>
                    investigateCore(
                        config,
                        issue,
                        {
                            ...options,
                            agentRuntime: {
                                ...options.agentRuntime,
                                executorDependencies: {
                                    ...options.agentRuntime?.executorDependencies,
                                    [AdguardCliExecutorName]: {
                                        installationHost,
                                        createEvidenceRoute,
                                    },
                                },
                            },
                        },
                        coreDependencies,
                    ),
            });
        } finally {
            try {
                const receipt = await installationHost.cleanupUnclaimed();
                if (receipt.status === AdguardCliSandboxCleanupStatus.Cleaned) {
                    rmSync(privateCycleRoot, { recursive: true, force: true });
                } else {
                    // Logged, not swallowed: an uncleaned residue keeps its private root for
                    // diagnosis instead of removing evidence of why the cleanup was incomplete.
                    console.error(
                        'adguard-cli backlog installation cleanup left residue; retaining the private root',
                        { privateCycleRoot, receipt },
                    );
                }
            } catch (error) {
                console.error(
                    'adguard-cli backlog installation cleanup failed; retaining the private root',
                    error,
                    { privateCycleRoot },
                );
            }
        }
    };
}

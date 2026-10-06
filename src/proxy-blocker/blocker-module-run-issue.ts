/**
 * The per-issue engine of a run that enables blocker-module executors: the shared public
 * `runDefaultSingleIssue` composition, unchanged, with each module wired into every issue's own
 * investigation through `FixCoreOptions.agentRuntime.executorDependencies`. Without this wiring a
 * locked module selection finds no module and ends capability-limited. Every other behavior —
 * workspace preparation, GitHub publication, the durable revision marker — stays exactly the public
 * engine's own; only the investigation seam is wrapped. The action and any other caller build their
 * `runIssue` seam here, so they never drift.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockerContract } from '../blocker-contract/blocker-contract';
import { runDefaultSingleIssue } from '../entry/single-issue-run';
import type {
    DefaultSingleIssueRequest,
    DefaultSingleIssueResult,
} from '../entry/single-issue-run-types';
import type { ExecutorName } from '../environment/executor-name';
import { extractReport } from '../intake/extract-report';
import { runFixCore } from '../orchestrator/fix-core';
import type { BlockerModuleRunDependencies } from './blocker-module-executor';
import { reservePrivateWorkspace } from './private-workspace';

/**
 * Directory below the agent workspace the official filter lists are cached in across runs.
 */
const FILTER_CACHE_DIRECTORY = join('tmp', 'filter-cache');

/**
 * One blocker module a run enables.
 */
export interface EnabledBlockerModule {
    /**
     * Executor name the module registered under.
     */
    executor: ExecutorName;

    /**
     * Start the module for one issue.
     *
     * @param workspaceDir - Private directory the module may keep its own files in.
     * @returns The started module.
     */
    startBlocker: (workspaceDir: string) => BlockerContract;
}

/**
 * Injectable seams of the per-issue engine; production passes nothing.
 */
export interface BlockerModuleRunIssueDependencies {
    /**
     * Per-issue investigation seam; production composes the shared public engine.
     */
    runDefaultSingleIssue?: typeof runDefaultSingleIssue;

    /**
     * Private workspace reservation; production reserves a fresh mode-0700 temp directory.
     */
    reservePrivateWorkspace?: typeof reservePrivateWorkspace;

    /**
     * GitHub-independent investigation core; production investigates through runFixCore.
     */
    runFixCore?: typeof runFixCore;
}

/**
 * Build the per-issue `runIssue` seam: the shared public engine, with every enabled module wired
 * into every issue's own investigation. Each issue gets its own private workspace and its own
 * module instance, so two issues running back to back never share blocker state.
 *
 * @param workspaceRoot - Agent workspace root the filter cache lives under.
 * @param modules - The modules the run enables.
 * @param dependencies - Injectable seams; production passes nothing.
 * @returns The per-issue seam.
 */
export function createBlockerModuleRunIssue(
    workspaceRoot: string,
    modules: readonly EnabledBlockerModule[],
    dependencies: BlockerModuleRunIssueDependencies = {},
): (request: DefaultSingleIssueRequest) => Promise<DefaultSingleIssueResult> {
    const runIssue = dependencies.runDefaultSingleIssue ?? runDefaultSingleIssue;
    const reserve = dependencies.reservePrivateWorkspace ?? reservePrivateWorkspace;
    const investigateCore = dependencies.runFixCore ?? runFixCore;
    const filterCacheDir = join(workspaceRoot, FILTER_CACHE_DIRECTORY);

    return async (request: DefaultSingleIssueRequest): Promise<DefaultSingleIssueResult> => {
        // The reservation resolves every forbidden root, and the action hands over an artifacts
        // path the entry has not created yet; creating it here, with the entry's own mode, lets
        // the overlap check see it.
        mkdirSync(request.artifactsDir, { recursive: true, mode: 0o700 });
        const workspaceDir = reserve([workspaceRoot, request.artifactsDir]);
        const moduleDependencies = Object.fromEntries(
            modules.map((module): [ExecutorName, BlockerModuleRunDependencies] => [
                module.executor,
                {
                    startBlocker: module.startBlocker,
                    workspaceDir: join(workspaceDir, module.executor),
                    filterCacheDir,
                },
            ]),
        );
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
                                    ...moduleDependencies,
                                },
                            },
                        },
                        coreDependencies,
                    ),
            });
        } finally {
            // The route stopped every module it started when the run ended; what is left is files.
            rmSync(workspaceDir, { recursive: true, force: true });
        }
    };
}

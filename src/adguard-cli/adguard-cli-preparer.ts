import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
    AdguardCliSandboxCleanupStatus,
    createPreparedAdguardCliInstallation,
    type AdguardCliInstallationHost,
    type AdguardCliPreparationOutcome,
    type AdguardCliSandboxCleanupReceipt,
    type PreparedAdguardCliInstallation,
} from './adguard-cli-installation';
import {
    AdguardCliPreparationLimitationCode,
    AdguardCliPreparationStage,
} from './adguard-cli-preparation-limitation';

/**
 * Construction input for the AdGuard CLI installation host.
 */
export interface CreateAdguardCliInstallationHostInput {
    /**
     * Private cycle root the sandbox directories are reserved under.
     */
    privateCycleRoot: string;

    /**
     * Absolute path of the `adguard-cli` executable, or null when none is configured.
     */
    binaryPath: string | null;

    /**
     * Host wall-clock source.
     */
    now?: () => string;
}

/**
 * Create the installation host for a configured AdGuard CLI engine.
 *
 * The product-CLI host this replaces resolved a GitHub release, downloaded a 44MB archive, verified
 * its signature, and executed the product binary for a version probe — none of which a run on the
 * AdGuard CLI route ever used. This host touches no network and executes nothing: it verifies the
 * configured binary exists and is executable, hashes its exact bytes, and reserves an inert sandbox
 * so the shared cleanup contract keeps holding.
 *
 * @param input - Private root, configured binary path, and optional clock.
 * @returns Installation host whose provenance honestly describes the local build.
 */
export function createAdguardCliInstallationHost(
    input: CreateAdguardCliInstallationHostInput,
): AdguardCliInstallationHost {
    const now = input.now ?? (() => new Date().toISOString());
    let ready: PreparedAdguardCliInstallation | null = null;
    let sandboxRoot: string | null = null;

    return {
        async prepare(): Promise<AdguardCliPreparationOutcome> {
            if (!input.binaryPath) {
                return {
                    ready: false,
                    limitation: {
                        stage: AdguardCliPreparationStage.Resolve,
                        code: AdguardCliPreparationLimitationCode.AdguardCliUnconfigured,
                        detail: 'No desktop engine is configured; set ADGUARD_CLI_PATH and ADGUARD_LICENSE_KEY (the AdGuard CLI needs both).',
                    },
                };
            }
            try {
                const facts = await stat(input.binaryPath);
                if (!facts.isFile()) {
                    throw new Error('not a regular file');
                }
                await access(input.binaryPath, constants.X_OK);
            } catch {
                return {
                    ready: false,
                    limitation: {
                        stage: AdguardCliPreparationStage.Resolve,
                        code: AdguardCliPreparationLimitationCode.AdguardCliBinaryUnavailable,
                        detail: 'The configured AdGuard CLI proxy executable is missing or not executable.',
                    },
                };
            }
            let binarySha256: string;
            try {
                binarySha256 = createHash('sha256')
                    .update(await readFile(input.binaryPath))
                    .digest('hex');
            } catch {
                return {
                    ready: false,
                    limitation: {
                        stage: AdguardCliPreparationStage.Verify,
                        code: AdguardCliPreparationLimitationCode.AdguardCliDigestFailed,
                        detail: 'The configured AdGuard CLI proxy executable could not be digested.',
                    },
                };
            }
            const sandboxId = randomUUID();
            const root = join(input.privateCycleRoot, `adguard-cli-${sandboxId.slice(0, 12)}`);
            const directories = {
                homePath: join(root, 'home'),
                xdgConfigPath: join(root, 'xdg-config'),
                xdgDataPath: join(root, 'xdg-data'),
                xdgCachePath: join(root, 'xdg-cache'),
                temporaryPath: join(root, 'tmp'),
                workingPath: join(root, 'work'),
            };
            try {
                for (const path of Object.values(directories)) {
                    await mkdir(path, { recursive: true, mode: 0o700 });
                }
            } catch {
                return {
                    ready: false,
                    limitation: {
                        stage: AdguardCliPreparationStage.Reserve,
                        code: AdguardCliPreparationLimitationCode.SandboxReservationFailed,
                        detail: 'A private AdGuard CLI sandbox could not be reserved safely.',
                    },
                };
            }
            sandboxRoot = root;
            ready = createPreparedAdguardCliInstallation({
                sandboxRoot: root,
                binaryPath: input.binaryPath,
                cliDataPath: join(directories.homePath, 'Library', 'Application Support'),
                ...directories,
            });
            return {
                ready: true,
                installation: ready,
                provenance: {
                    source: 'adguard_cli_build',
                    sandboxId,
                    binarySha256,
                    // This host executes nothing, so the engine version stays honestly unavailable
                    // here; the AdGuard CLI host logs its `--version` when it prepares.
                    engineVersion: { status: 'unavailable', value: 'unknown' },
                    preparedAt: now(),
                    capabilities: ['cli_installation'],
                },
            };
        },

        takeReadyInstallation(): PreparedAdguardCliInstallation | null {
            const taken = ready;
            ready = null;
            return taken;
        },

        async cleanupUnclaimed(): Promise<AdguardCliSandboxCleanupReceipt> {
            if (ready === null || sandboxRoot === null) {
                return {
                    status: AdguardCliSandboxCleanupStatus.Cleaned,
                    attempted: 0,
                    removed: 0,
                    residueCount: 0,
                    code: null,
                };
            }
            ready = null;
            try {
                await rm(sandboxRoot, { recursive: true, force: true });
                return {
                    status: AdguardCliSandboxCleanupStatus.Cleaned,
                    attempted: 1,
                    removed: 1,
                    residueCount: 0,
                    code: null,
                };
            } catch {
                return {
                    status: AdguardCliSandboxCleanupStatus.Partial,
                    attempted: 1,
                    removed: 0,
                    residueCount: 1,
                    code: AdguardCliPreparationLimitationCode.PartialSandboxCleanupFailed,
                };
            }
        },
    };
}

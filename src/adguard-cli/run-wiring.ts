/**
 * Shared AdGuard CLI run-wiring: a private CLI-owned filesystem root kept separate from every
 * checkout, output, or publication root the calling run already reserved, and the proxied
 * evidence-route factory that turns one prepared installation into a live filtering route. Every
 * caller that activates the `adguard_cli` executor for a run builds its installation host and route
 * factory through this one module — the lab's own local cycle and the shared public engine's
 * per-issue seam ({@link module:adguard-cli/adguard-cli-run-issue}) — so the two never drift.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describeProvenanceVersion, isAdguardCliBuildProvenance } from './adguard-cli-installation';
import type { AdguardCliEvidenceRouteFactory } from './filtering-executor';
import { createAdguardCliEvidenceRouteHost } from './adguard-cli-evidence-route';
import {
    ADGUARD_CLI_HOME_ARCHIVE_ENV,
    ADGUARD_CLI_PATH_ENV,
    ADGUARD_LICENSE_KEY_ENV,
    createAdguardCliProxyHost,
} from './adguard-cli-proxy';
import { createLogger } from '../logger/logger';

/**
 * Determine whether candidate is a strict descendant of root.
 *
 * @param root - Canonical containment root.
 * @param candidate - Canonical candidate path.
 * @returns Whether candidate remains strictly below root.
 */
function isStrictPathDescendant(root: string, candidate: string): boolean {
    const child = relative(root, candidate);
    return (
        child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !child.startsWith(sep)
    );
}

/**
 * The AdGuard CLI release a process drives, resolved once and shared by the preparer, which hashes
 * the binary, and the route factory, which launches it.
 */
export interface DesktopEngine {
    /**
     * Absolute path of the `adguard-cli` executable.
     */
    binaryPath: string;

    /**
     * Licence the CLI is activated with when no seeded HOME can be restored.
     */
    licenseKey: string;

    /**
     * Seeded HOME archive each run restores instead of activating, when configured.
     */
    seededHomeArchive?: string;
}

/**
 * Resolve the desktop engine. The AdGuard CLI needs both its executable and its licence; without
 * either there is no engine, and the run reports the unconfigured-engine limitation.
 *
 * @param environment - Environment naming the executable and the licence.
 * @returns The engine, or null when none is usable.
 */
export function resolveDesktopEngine(environment: NodeJS.ProcessEnv): DesktopEngine | null {
    const binaryPath = environment[ADGUARD_CLI_PATH_ENV];
    const licenseKey = environment[ADGUARD_LICENSE_KEY_ENV];
    if (!binaryPath || !licenseKey) {
        return null;
    }
    return {
        binaryPath,
        licenseKey,
        seededHomeArchive: environment[ADGUARD_CLI_HOME_ARCHIVE_ENV] || undefined,
    };
}

/**
 * Reserve one mode-0700 private CLI root below the canonical operating-system temp directory.
 *
 * @param forbiddenRoots - Existing repository, output, and publication roots to keep separate.
 * @returns Canonical fresh private root.
 */
export function reservePrivateCliCycleRoot(forbiddenRoots: readonly string[]): string {
    const canonicalTemporaryRoot = realpathSync(tmpdir());
    const root = realpathSync(mkdtempSync(join(canonicalTemporaryRoot, 'adguard-agent-cli-')));
    try {
        chmodSync(root, 0o700);
        if (!isStrictPathDescendant(canonicalTemporaryRoot, root)) {
            throw new Error('Private CLI root escaped the operating-system temp directory.');
        }
        for (const forbidden of forbiddenRoots) {
            const canonicalForbidden = realpathSync(forbidden);
            if (root === canonicalForbidden || isStrictPathDescendant(canonicalForbidden, root)) {
                throw new Error('Private CLI root overlaps a forbidden repository or output root.');
            }
        }
        return root;
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Build the run's proxied evidence-route factory for the resolved desktop engine. The run executes
 * exactly the filter files it downloaded. A host without an engine never reaches this factory — the
 * preparer already reported the typed preparation limitation.
 *
 * @param workspaceRoot - Workspace holding durable state and the filter cache.
 * @param engine - The engine {@link resolveDesktopEngine} resolved, shared with the preparer.
 * @returns Runtime dependency creating one run-owned evidence route.
 */
export function createProductionEvidenceRouteFactory(
    workspaceRoot: string,
    engine: DesktopEngine | null,
): AdguardCliEvidenceRouteFactory {
    // The proxy's lifecycle and licence steps go to the run's own output, where the attempt log
    // and its redaction already apply.
    const logger = createLogger();
    return (_installation, provenance, context) => {
        // Fail closed on a legacy release-shaped provenance: it cannot describe the engine this
        // factory would run, and after the local-binary switch it never occurs in production.
        if (engine === null || !isAdguardCliBuildProvenance(provenance)) {
            return null;
        }
        return createAdguardCliEvidenceRouteHost({
            cycleId: provenance.sandboxId,
            binaryPath: engine.binaryPath,
            createProxy: (proxyInput) =>
                createAdguardCliProxyHost({
                    ...proxyInput,
                    licenseKey: engine.licenseKey,
                    seededHomeArchive: engine.seededHomeArchive,
                }),
            workspaceDir: join(
                tmpdir(),
                `adguard-agent-cli-route-${provenance.sandboxId.slice(0, 12)}`,
            ),
            filterCacheDir: join(workspaceRoot, 'tmp', 'filter-cache'),
            reporterFilterIds: context.reporterFilterIds,
            cliVersion: describeProvenanceVersion(provenance),
            logger,
        });
    };
}

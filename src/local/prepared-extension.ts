/**
 * PreparedExtension — the host-validated unpacked extension every fix run carries into its browser
 * sessions, and the provenance vocabulary that replaces the build-from-source cache record at the
 * runtime seam.
 *
 * Exactly ONE PreparedExtension exists per run, prepared before the fix session starts: the host
 * downloads the operator-pinned prebuilt release, or adopts the directory the short-lived
 * preparation session built from the instruction's `## Preparation` section. The source kind is
 * recorded so run records state where the loaded build came from; the digest pins the exact source
 * bytes and makes substitution detectable. (A third source, an operator-preloaded directory, was
 * dropped in 27-AFK; `PreparedExtensionSource.Preloaded` stays parseable for run records persisted
 * before the drop.)
 */
import { readFileSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
    EXTENSION_MANIFEST_VERSION_VALUES,
    ExtensionManifestVersion,
    PreparedExtensionSource,
} from '../environment/extension-preparation';

/**
 * The one unpacked extension build this run loads into its browser sessions.
 *
 * Validated at creation: the directory exists and carries `manifest.json`. This is the shape the
 * launch wiring reads (`extensionPath`, `manifestVersion`) and the run-record provenance blocks
 * serialize.
 */
export interface PreparedExtension {
    /**
     * Absolute path of the unpacked directory (manifest.json at its root).
     */
    extensionPath: string;

    /**
     * Manifest generation the unpacked build ships.
     */
    manifestVersion: ExtensionManifestVersion;

    /**
     * Where this build came from.
     */
    source: PreparedExtensionSource;

    /**
     * Digest pinning the exact extension source: the verified release download for the pinned
     * release, the instruction section content for an instruction build, and the manifest.json
     * bytes for a preloaded directory (there the operator directory itself is the source).
     */
    extensionSourceSha256: string;

    /**
     * Release tag the build came from, when it is a release build.
     */
    extensionSourceTag?: string;
}

/**
 * The one file the browser cannot load an extension without.
 */
const MANIFEST_FILE_NAME = 'manifest.json';

/**
 * The manifest field naming the package version.
 */
const PACKAGE_VERSION_FIELD = 'version';

/**
 * The manifest field naming the manifest generation.
 */
const MANIFEST_VERSION_FIELD = 'manifest_version';

/**
 * The parsed browser-relevant facts of one unpacked extension manifest.
 */
export interface PreparedExtensionManifestFacts {
    /**
     * The package version the manifest declares.
     */
    packageVersion: string;

    /**
     * The manifest generation the manifest declares.
     */
    manifestVersion: ExtensionManifestVersion;
}

/**
 * Test whether one parsed manifest field names a known manifest generation.
 *
 * @param value - The parsed `manifest_version` field of unknown shape.
 * @returns Whether the value is exactly one declared generation.
 */
function isKnownManifestVersion(value: unknown): value is ExtensionManifestVersion {
    return EXTENSION_MANIFEST_VERSION_VALUES.some((entry) => entry === value);
}

/**
 * Read and classify the manifest facts of one unpacked extension directory.
 *
 * @param extensionPath - Absolute unpacked directory (manifest.json at its root).
 * @returns The declared package version and manifest generation.
 * @throws When the directory is missing, the manifest is missing, or the manifest does not declare
 *   a known generation — a hosted directory the browser would refuse to load anyway.
 */
export function readPreparedExtensionManifest(
    extensionPath: string,
): PreparedExtensionManifestFacts {
    const manifestPath = join(extensionPath, MANIFEST_FILE_NAME);
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
        throw new Error(
            `The prepared extension directory ${extensionPath} holds no readable ` +
                `${MANIFEST_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}.`,
            { cause: error },
        );
    }
    const packageVersion = raw[PACKAGE_VERSION_FIELD];
    if (typeof packageVersion !== 'string' || packageVersion.trim().length === 0) {
        throw new Error(
            `The prepared extension manifest at ${manifestPath} declares no ` +
                `${PACKAGE_VERSION_FIELD} string.`,
        );
    }
    const manifestVersion = raw[MANIFEST_VERSION_FIELD];
    if (!isKnownManifestVersion(manifestVersion)) {
        throw new Error(
            `The prepared extension manifest at ${manifestPath} declares ` +
                `manifest_version=${String(manifestVersion)}; a known generation ` +
                `(${EXTENSION_MANIFEST_VERSION_VALUES.join(' or ')}) is required.`,
        );
    }
    return { packageVersion, manifestVersion };
}

/**
 * Validate one unpacked directory as a loadable prepared extension and build the record for it.
 *
 * @param extensionPath - Absolute unpacked directory.
 * @param source - Where this build came from.
 * @param extensionSourceSha256 - Digest pinning the extension source.
 * @param sourceTag - Optional release tag the build came from.
 * @param expectedManifestVersion - Optional manifest generation the source established (a pinned
 *   release pin, or the preparation session's build target); a mismatch fails named here, before
 *   any browser session loads the wrong generation.
 * @returns The validated PreparedExtension.
 * @throws When the directory is missing or carries no readable manifest with a known generation.
 */
export async function loadPreparedExtensionFromDirectory(
    extensionPath: string,
    source: PreparedExtensionSource,
    extensionSourceSha256: string,
    sourceTag?: string,
    expectedManifestVersion?: ExtensionManifestVersion,
): Promise<PreparedExtension> {
    const directory = await stat(extensionPath).catch(() => undefined);
    if (directory === undefined || !directory.isDirectory()) {
        throw new Error(`The prepared extension directory ${extensionPath} does not exist.`);
    }
    await access(join(extensionPath, MANIFEST_FILE_NAME)).catch(() => {
        throw new Error(
            `The prepared extension directory ${extensionPath} carries no ` +
                `${MANIFEST_FILE_NAME}; the browser cannot load it.`,
        );
    });
    const manifest = readPreparedExtensionManifest(extensionPath);
    if (
        expectedManifestVersion !== undefined &&
        manifest.manifestVersion !== expectedManifestVersion
    ) {
        throw new Error(
            `The prepared extension loaded from ${extensionPath} ships ` +
                `manifest_version=${manifest.manifestVersion}; the source established ` +
                `${expectedManifestVersion}.`,
        );
    }
    return {
        extensionPath,
        manifestVersion: manifest.manifestVersion,
        source,
        extensionSourceSha256,
        ...(sourceTag === undefined ? {} : { extensionSourceTag: sourceTag }),
    };
}

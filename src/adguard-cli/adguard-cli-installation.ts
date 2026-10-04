import * as v from 'valibot';
import { AdguardCliPreparationLimitationSchema } from './adguard-cli-preparation-limitation';
import { REPOSITORY_SLUG_PATTERN } from '../types/repository-slug';

/**
 * Maximum accepted AdGuard CLI release archive size.
 */
const MAXIMUM_RELEASE_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Strict lowercase SHA-256 representation used by public provenance.
 */
const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));

/**
 * Strict version representation emitted by the selected release and verified binary.
 */
const ExactVersionSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(100),
    v.regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u),
);

export const AdguardCliReleaseIdentitySchema = v.pipe(
    v.strictObject({
        repository: v.pipe(v.string(), v.regex(REPOSITORY_SLUG_PATTERN)),
        releaseId: v.pipe(v.number(), v.integer(), v.minValue(1), v.safeInteger()),
        tag: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
        cliVersion: ExactVersionSchema,
        publishedAt: v.pipe(v.string(), v.isoTimestamp()),
        target: v.picklist(['macos-universal', 'linux-x86_64', 'linux-aarch64']),
        assetId: v.pipe(v.number(), v.integer(), v.minValue(1), v.safeInteger()),
        assetName: v.pipe(
            v.string(),
            v.regex(
                /^adguard-cli-(?:\d+\.\d+\.\d+-)?(?:macos|linux-x86_64|linux-aarch64)\.tar\.gz$/u,
            ),
        ),
        assetUrl: v.pipe(v.string(), v.url(), v.maxLength(2_000)),
        assetBytes: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(MAXIMUM_RELEASE_ARCHIVE_BYTES),
            v.safeInteger(),
        ),
        assetSha256: Sha256Schema,
        publicKeySha256: Sha256Schema,
    }),
    v.check((identity) => {
        const legacyAsset = {
            'macos-universal': 'adguard-cli-macos.tar.gz',
            'linux-x86_64': 'adguard-cli-linux-x86_64.tar.gz',
            'linux-aarch64': 'adguard-cli-linux-aarch64.tar.gz',
        }[identity.target];
        const versionedAsset = legacyAsset.replace(
            'adguard-cli-',
            `adguard-cli-${identity.cliVersion}-`,
        );
        if (identity.assetName !== legacyAsset && identity.assetName !== versionedAsset) {
            return false;
        }
        if (
            identity.tag !== `v${identity.cliVersion}` &&
            identity.tag !== `v${identity.cliVersion}-release`
        ) {
            return false;
        }
        const url = new URL(identity.assetUrl);
        return (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '' &&
            url.pathname ===
                `/${identity.repository}/releases/download/${identity.tag}/${identity.assetName}`
        );
    }, 'Release asset identity must match the record repository, the official stable target, and URL.'),
);

export const AdguardCliVersionProvenanceSchema = v.variant('status', [
    v.strictObject({
        status: v.literal('known'),
        value: ExactVersionSchema,
    }),
    v.strictObject({
        status: v.literal('unavailable'),
        value: v.literal('unknown'),
    }),
]);

export const AdguardCliGithubReleaseProvenanceSchema = v.pipe(
    v.strictObject({
        sandboxId: v.pipe(v.string(), v.uuid()),
        release: AdguardCliReleaseIdentitySchema,
        archiveSha256: Sha256Schema,
        binarySha256: Sha256Schema,
        signatureAlgorithm: v.literal('ed25519'),
        cliVersion: ExactVersionSchema,
        adguardCliVersion: AdguardCliVersionProvenanceSchema,
        preparedAt: v.pipe(v.string(), v.isoTimestamp()),
        capabilities: v.tuple([v.literal('cli_installation')]),
    }),
    v.check(
        (provenance) =>
            provenance.cliVersion === provenance.release.cliVersion &&
            provenance.archiveSha256 === provenance.release.assetSha256,
        'Installed version and archive must remain bound to the resolved release.',
    ),
);

/**
 * Provenance of a configured AdGuard CLI engine.
 *
 * Deliberately carries no release identity, archive digest, signature algorithm, or pinned CLI
 * version: a local build has none of those, and a shape that cannot express them cannot fabricate
 * them. The engine version is honest too: the preparer executes nothing, so it is `unavailable`.
 */
export const AdguardCliBuildProvenanceSchema = v.strictObject({
    source: v.literal('adguard_cli_build'),
    sandboxId: v.pipe(v.string(), v.uuid()),
    binarySha256: Sha256Schema,
    engineVersion: AdguardCliVersionProvenanceSchema,
    preparedAt: v.pipe(v.string(), v.isoTimestamp()),
    capabilities: v.tuple([v.literal('cli_installation')]),
});

// The legacy release member has no discriminator: records persisted before the local-binary
// switch must keep parsing byte-for-byte. The strict objects are disjoint (`source` vs `release`),
// so the union stays unambiguous.
export const AdguardCliInstallationProvenanceSchema = v.union([
    AdguardCliBuildProvenanceSchema,
    AdguardCliGithubReleaseProvenanceSchema,
]);

/**
 * Narrow one installation provenance to the configured AdGuard CLI member.
 *
 * @param provenance - Either provenance union member.
 * @returns Whether the installation is the configured AdGuard CLI binary.
 */
export function isAdguardCliBuildProvenance(
    provenance: v.InferOutput<typeof AdguardCliInstallationProvenanceSchema>,
): provenance is v.InferOutput<typeof AdguardCliBuildProvenanceSchema> {
    return 'source' in provenance && provenance.source === 'adguard_cli_build';
}

/**
 * Resolve the product version one prepared installation may honestly claim.
 *
 * Every surface that reports a version — the selection snapshot, the adapter's actual context, the
 * evidence route ports — must derive it through this single seam, or the recorder's byte-equality
 * between them fails mid-run.
 *
 * @param provenance - Either provenance union member.
 * @returns Exact version, or null when the engine build does not know one.
 */
export function describeProvenanceVersion(
    provenance: v.InferOutput<typeof AdguardCliInstallationProvenanceSchema>,
): string | null {
    if (isAdguardCliBuildProvenance(provenance)) {
        return provenance.engineVersion.status === 'known' ? provenance.engineVersion.value : null;
    }
    return provenance.cliVersion;
}

/**
 * The product name a prepared installation claims as the executor.
 *
 * The selection snapshot and the executing adapter byte-compare their actual contexts, so both must
 * use this one label.
 */
export const ADGUARD_CLI_PRODUCT = 'AdGuard CLI';

/**
 * Outcome of one attempt to remove unclaimed AdGuard CLI sandbox residue.
 */
export const AdguardCliSandboxCleanupStatus = {
    /**
     * Every unclaimed sandbox found was removed.
     */
    Cleaned: 'cleaned',

    /**
     * At least one unclaimed sandbox could not be removed.
     */
    Partial: 'partial',
} as const;

/**
 * Every AdguardCliSandboxCleanupStatus value, for schemas and exhaustive listings.
 */
export const CORE_LIBS_SANDBOX_CLEANUP_STATUS_VALUES = Object.values(
    AdguardCliSandboxCleanupStatus,
);

/**
 * AdguardCliSandboxCleanupStatus value.
 */
export type AdguardCliSandboxCleanupStatus =
    (typeof AdguardCliSandboxCleanupStatus)[keyof typeof AdguardCliSandboxCleanupStatus];

export const AdguardCliSandboxCleanupReceiptSchema = v.pipe(
    v.strictObject({
        status: v.picklist(CORE_LIBS_SANDBOX_CLEANUP_STATUS_VALUES),
        attempted: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)),
        removed: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)),
        residueCount: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_024)),
        code: v.nullable(v.literal('partial_sandbox_cleanup_failed')),
    }),
    v.check((receipt) => {
        if (receipt.attempted !== receipt.removed + receipt.residueCount) {
            return false;
        }
        return receipt.status === AdguardCliSandboxCleanupStatus.Cleaned
            ? receipt.residueCount === 0 && receipt.code === null
            : receipt.residueCount > 0 && receipt.code === 'partial_sandbox_cleanup_failed';
    }, 'Cleanup receipt counts and status must describe the same bounded cleanup attempt.'),
);

/**
 * Runtime-only paths held behind the opaque prepared-installation capability.
 */
export interface PreparedAdguardCliInstallationState {
    /**
     * Canonical root of this one prepared sandbox.
     */
    sandboxRoot: string;

    /**
     * Canonical path of the verified executable.
     */
    binaryPath: string;

    /**
     * Sandbox-owned HOME passed to the CLI.
     */
    homePath: string;

    /**
     * Platform HOME-derived AdGuard CLI state directory.
     */
    cliDataPath: string;

    /**
     * Sandbox-owned XDG configuration directory.
     */
    xdgConfigPath: string;

    /**
     * Sandbox-owned XDG data directory.
     */
    xdgDataPath: string;

    /**
     * Sandbox-owned XDG cache directory.
     */
    xdgCachePath: string;

    /**
     * Sandbox-owned temporary directory.
     */
    temporaryPath: string;

    /**
     * Sandbox-owned subprocess working directory.
     */
    workingPath: string;
}

/**
 * Compile-time brand for the empty opaque capability object.
 */
declare const preparedAdguardCliInstallationBrand: unique symbol;

/**
 * Host-only handle to one verified installation.
 */
export interface PreparedAdguardCliInstallation {
    /**
     * Prevent callers from constructing a capability structurally.
     */
    readonly [preparedAdguardCliInstallationBrand]: true;
}

/**
 * Runtime state for capabilities that cannot be serialized or cloned.
 */
const preparedInstallationState = new WeakMap<
    PreparedAdguardCliInstallation,
    Readonly<PreparedAdguardCliInstallationState>
>();

/**
 * Validate an opaque installation object inside Valibot schemas.
 */
const PreparedAdguardCliInstallationSchema = v.custom<PreparedAdguardCliInstallation>(
    (value) => isPreparedAdguardCliInstallation(value),
    'Expected a host-issued prepared AdGuard CLI installation.',
);

export const AdguardCliPreparationOutcomeSchema = v.variant('ready', [
    v.strictObject({
        ready: v.literal(true),
        installation: PreparedAdguardCliInstallationSchema,
        provenance: AdguardCliInstallationProvenanceSchema,
    }),
    v.strictObject({
        ready: v.literal(false),
        limitation: AdguardCliPreparationLimitationSchema,
    }),
]);

/**
 * Path-free public provenance of one prepared installation.
 */
export type AdguardCliInstallationProvenance = v.InferOutput<
    typeof AdguardCliInstallationProvenanceSchema
>;

/**
 * Path-free result of cleanup for unclaimed installation reservations.
 */
export type AdguardCliSandboxCleanupReceipt = v.InferOutput<
    typeof AdguardCliSandboxCleanupReceiptSchema
>;

/**
 * Ready installation capability or one stage-bound limitation.
 */
export type AdguardCliPreparationOutcome = v.InferOutput<typeof AdguardCliPreparationOutcomeSchema>;

/**
 * Host boundary that owns preparation capabilities and cleanup residue.
 */
export interface AdguardCliInstallationHost {
    /**
     * Prepare a fresh AdGuard CLI engine installation.
     *
     * @returns Ready opaque capability or a stable stage limitation.
     */
    prepare(): Promise<AdguardCliPreparationOutcome>;

    /**
     * Transfer the one ready capability to the next lifecycle slice.
     *
     * @returns Prepared installation once, or null when unavailable/already claimed.
     */
    takeReadyInstallation(): PreparedAdguardCliInstallation | null;

    /**
     * Remove every unclaimed reservation and retained owned residue.
     *
     * @returns Bounded path-free cleanup receipt.
     */
    cleanupUnclaimed(): Promise<AdguardCliSandboxCleanupReceipt>;
}

/**
 * Issue an opaque empty capability backed only by WeakMap-held runtime state.
 *
 * @param state - Canonical sandbox-owned runtime paths.
 * @returns Frozen non-serializable host capability.
 */
export function createPreparedAdguardCliInstallation(
    state: PreparedAdguardCliInstallationState,
): PreparedAdguardCliInstallation {
    const installation = Object.freeze(Object.create(null)) as PreparedAdguardCliInstallation;
    preparedInstallationState.set(installation, Object.freeze(structuredClone(state)));
    return installation;
}

/**
 * Determine whether a value is a capability issued by this process.
 *
 * @param value - Unknown value crossing a host boundary.
 * @returns Whether the value owns private prepared-installation state.
 */
export function isPreparedAdguardCliInstallation(
    value: unknown,
): value is PreparedAdguardCliInstallation {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        preparedInstallationState.has(value as PreparedAdguardCliInstallation)
    );
}

/**
 * Read a defensive copy of runtime-only capability state inside trusted Host code.
 *
 * @param installation - Host-issued opaque capability.
 * @returns Canonical private paths, or null for a forged/stale handle.
 */
export function inspectPreparedAdguardCliInstallation(
    installation: PreparedAdguardCliInstallation,
): PreparedAdguardCliInstallationState | null {
    const state = preparedInstallationState.get(installation);
    return state ? structuredClone(state) : null;
}

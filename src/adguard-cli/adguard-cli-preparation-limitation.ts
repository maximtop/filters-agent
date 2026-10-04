import * as v from 'valibot';

/**
 * The path-free AdGuard CLI preparation-limitation vocabulary: the stage a preparation reached, the
 * stage-bound code that ended it, the mapping that binds each code to exactly one stage, and the
 * public limitation shape those three compose into. It is what a failed preparation is allowed to
 * say out loud — the detail schema below rejects host paths and raw output — so it is declared once
 * here and imported by the installation contract, the local preparer, the environment selection and
 * the agent runtime instead of being respelled at each of them.
 */

/**
 * Named pipeline stage an AdGuard CLI installation attempt is in when it fails or completes.
 *
 * Every {@link AdguardCliPreparationLimitationCode} is attributed to exactly one of these stages by
 * {@link CLI_PREPARATION_STAGE_BY_LIMITATION_CODE}.
 */
export const AdguardCliPreparationStage = {
    /**
     * Reserving sandbox space for a fresh installation attempt.
     */
    Reserve: 'reserve',

    /**
     * Selecting the release target for the local host platform.
     */
    Platform: 'platform',

    /**
     * Resolving the stable release and asset metadata to install.
     */
    Resolve: 'resolve',

    /**
     * Downloading the resolved release archive.
     */
    Download: 'download',

    /**
     * Quarantining and validating the downloaded archive before install.
     */
    Quarantine: 'quarantine',

    /**
     * Verifying the archive or binary digest and signature.
     */
    Verify: 'verify',

    /**
     * Promoting verified files into the sandbox installation.
     */
    Install: 'install',

    /**
     * Probing the installed binary to confirm its version and isolation.
     */
    Probe: 'probe',

    /**
     * Recording and cross-checking provenance for the prepared installation.
     */
    Provenance: 'provenance',

    /**
     * Cleaning up unclaimed sandbox reservations.
     */
    Cleanup: 'cleanup',
} as const;

/**
 * Every AdguardCliPreparationStage value, for schemas and exhaustive listings.
 */
export const CORE_LIBS_PREPARATION_STAGE_VALUES = Object.values(AdguardCliPreparationStage);

export const AdguardCliPreparationStageSchema = v.picklist(CORE_LIBS_PREPARATION_STAGE_VALUES);

/**
 * Stable path-free reason an AdGuard CLI preparation attempt did not produce a ready installation.
 */
export const AdguardCliPreparationLimitationCode = {
    /**
     * The installation sandbox could not be reserved.
     */
    SandboxReservationFailed: 'sandbox_reservation_failed',

    /**
     * The local host platform has no supported AdGuard CLI release target.
     */
    UnsupportedPlatform: 'unsupported_platform',

    /**
     * The AdGuard CLI proxy binary location was not configured for this environment.
     */
    AdguardCliUnconfigured: 'adguard_cli_unconfigured',

    /**
     * The AdGuard CLI proxy binary could not be found at the configured location.
     */
    AdguardCliBinaryUnavailable: 'adguard_cli_binary_unavailable',

    /**
     * The built AdGuard CLI proxy binary's digest could not be computed or verified.
     */
    AdguardCliDigestFailed: 'adguard_cli_digest_failed',

    /**
     * No stable AdGuard CLI release was available to resolve.
     */
    StableReleaseUnavailable: 'stable_release_unavailable',

    /**
     * The GitHub releases API rate-limited the release lookup.
     */
    ReleaseApiRateLimited: 'release_api_rate_limited',

    /**
     * Fetching release metadata timed out.
     */
    ReleaseMetadataTimeout: 'release_metadata_timeout',

    /**
     * The fetched release metadata did not match the expected shape.
     */
    ReleaseMetadataInvalid: 'release_metadata_invalid',

    /**
     * The stable release carried no matching asset for this platform.
     */
    StableAssetUnavailable: 'stable_asset_unavailable',

    /**
     * The selected release asset's metadata did not match the expected shape.
     */
    AssetMetadataInvalid: 'asset_metadata_invalid',

    /**
     * Downloading the release archive failed.
     */
    DownloadFailed: 'download_failed',

    /**
     * Downloading the release archive timed out.
     */
    AssetDownloadTimeout: 'asset_download_timeout',

    /**
     * The downloaded archive exceeded the maximum accepted size.
     */
    DownloadLimitExceeded: 'download_limit_exceeded',

    /**
     * The downloaded archive's digest did not match the published asset digest.
     */
    AssetDigestMismatch: 'asset_digest_mismatch',

    /**
     * The quarantined archive could not be read or extracted.
     */
    ArchiveInvalid: 'archive_invalid',

    /**
     * The extracted archive exceeded the sandbox's size limit.
     */
    ArchiveLimitExceeded: 'archive_limit_exceeded',

    /**
     * The archive could not be written to the quarantine location.
     */
    QuarantineWriteFailed: 'quarantine_write_failed',

    /**
     * The release carried no signature to verify against.
     */
    SignatureMissing: 'signature_missing',

    /**
     * The release signature did not verify against the pinned public key.
     */
    SignatureInvalid: 'signature_invalid',

    /**
     * The verified files could not be promoted into the sandbox installation.
     */
    InstallationPromotionFailed: 'installation_promotion_failed',

    /**
     * Probing the installed binary's version failed.
     */
    VersionProbeFailed: 'version_probe_failed',

    /**
     * The installed binary could not be spawned to probe its version.
     */
    VersionProbeSpawnFailed: 'version_probe_spawn_failed',

    /**
     * Probing the installed binary's version timed out.
     */
    VersionProbeTimeout: 'version_probe_timeout',

    /**
     * The version probe process exited with a non-zero status.
     */
    VersionProbeExitFailed: 'version_probe_exit_failed',

    /**
     * The version probe process was terminated by a signal.
     */
    VersionProbeSignal: 'version_probe_signal',

    /**
     * The version probe's output exceeded the accepted size limit.
     */
    VersionProbeLimitExceeded: 'version_probe_limit_exceeded',

    /**
     * The probed binary version did not match the resolved release's pinned version.
     */
    CliVersionMismatch: 'cli_version_mismatch',

    /**
     * No version evidence was available to record for the prepared engine.
     */
    VersionProvenanceUnavailable: 'version_provenance_unavailable',

    /**
     * The prepared CLI capability could not be transferred into the run's evidence route.
     */
    CliInstallationCapabilityUnavailable: 'cli_installation_capability_unavailable',

    /**
     * The locked CLI environment selection could not be retained for the prepared engine.
     */
    CliEnvironmentSelectionUnavailable: 'cli_environment_selection_unavailable',

    /**
     * The prepared sandbox's isolation from the host could not be verified.
     */
    IsolationUnverified: 'isolation_unverified',

    /**
     * Cleanup left residue in the unclaimed sandbox reservation.
     */
    PartialSandboxCleanupFailed: 'partial_sandbox_cleanup_failed',
} as const;

/**
 * Every AdguardCliPreparationLimitationCode value, for schemas and exhaustive listings.
 */
export const CORE_LIBS_PREPARATION_LIMITATION_CODE_VALUES = Object.values(
    AdguardCliPreparationLimitationCode,
);

export const AdguardCliPreparationLimitationCodeSchema = v.picklist(
    CORE_LIBS_PREPARATION_LIMITATION_CODE_VALUES,
);

/**
 * Stable stage ownership for every public preparation failure code.
 */
export const CLI_PREPARATION_STAGE_BY_LIMITATION_CODE = {
    [AdguardCliPreparationLimitationCode.SandboxReservationFailed]:
        AdguardCliPreparationStage.Reserve,
    [AdguardCliPreparationLimitationCode.UnsupportedPlatform]: AdguardCliPreparationStage.Platform,
    [AdguardCliPreparationLimitationCode.AdguardCliUnconfigured]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.AdguardCliBinaryUnavailable]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.AdguardCliDigestFailed]: AdguardCliPreparationStage.Verify,
    [AdguardCliPreparationLimitationCode.StableReleaseUnavailable]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.ReleaseApiRateLimited]: AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.ReleaseMetadataTimeout]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.ReleaseMetadataInvalid]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.StableAssetUnavailable]:
        AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.AssetMetadataInvalid]: AdguardCliPreparationStage.Resolve,
    [AdguardCliPreparationLimitationCode.DownloadFailed]: AdguardCliPreparationStage.Download,
    [AdguardCliPreparationLimitationCode.AssetDownloadTimeout]: AdguardCliPreparationStage.Download,
    [AdguardCliPreparationLimitationCode.DownloadLimitExceeded]:
        AdguardCliPreparationStage.Download,
    [AdguardCliPreparationLimitationCode.AssetDigestMismatch]: AdguardCliPreparationStage.Download,
    [AdguardCliPreparationLimitationCode.ArchiveInvalid]: AdguardCliPreparationStage.Quarantine,
    [AdguardCliPreparationLimitationCode.ArchiveLimitExceeded]:
        AdguardCliPreparationStage.Quarantine,
    [AdguardCliPreparationLimitationCode.QuarantineWriteFailed]:
        AdguardCliPreparationStage.Quarantine,
    [AdguardCliPreparationLimitationCode.SignatureMissing]: AdguardCliPreparationStage.Verify,
    [AdguardCliPreparationLimitationCode.SignatureInvalid]: AdguardCliPreparationStage.Verify,
    [AdguardCliPreparationLimitationCode.InstallationPromotionFailed]:
        AdguardCliPreparationStage.Install,
    [AdguardCliPreparationLimitationCode.VersionProbeFailed]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.VersionProbeSpawnFailed]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.VersionProbeTimeout]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.VersionProbeExitFailed]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.VersionProbeSignal]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.VersionProbeLimitExceeded]:
        AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.IsolationUnverified]: AdguardCliPreparationStage.Probe,
    [AdguardCliPreparationLimitationCode.CliVersionMismatch]: AdguardCliPreparationStage.Provenance,
    [AdguardCliPreparationLimitationCode.VersionProvenanceUnavailable]:
        AdguardCliPreparationStage.Provenance,
    [AdguardCliPreparationLimitationCode.CliInstallationCapabilityUnavailable]:
        AdguardCliPreparationStage.Install,
    [AdguardCliPreparationLimitationCode.CliEnvironmentSelectionUnavailable]:
        AdguardCliPreparationStage.Install,
    [AdguardCliPreparationLimitationCode.PartialSandboxCleanupFailed]:
        AdguardCliPreparationStage.Cleanup,
} as const satisfies Record<
    v.InferOutput<typeof AdguardCliPreparationLimitationCodeSchema>,
    v.InferOutput<typeof AdguardCliPreparationStageSchema>
>;

/**
 * Reject host paths and multiline raw output from public limitation detail.
 */
const PublicLimitationDetailSchema = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(500),
    v.check(
        (detail) =>
            !/[\r\n]/u.test(detail) &&
            !/(?:^|\s)(?:\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)/u.test(detail),
        'Limitation detail must not contain raw output or host paths.',
    ),
);

export const AdguardCliPreparationLimitationSchema = v.pipe(
    v.strictObject({
        stage: AdguardCliPreparationStageSchema,
        code: AdguardCliPreparationLimitationCodeSchema,
        detail: PublicLimitationDetailSchema,
    }),
    v.check(
        (limitation) =>
            CLI_PREPARATION_STAGE_BY_LIMITATION_CODE[limitation.code] === limitation.stage,
        'Preparation limitation code must belong to its declared stage.',
    ),
);

/**
 * Stable preparation stage.
 */
export type AdguardCliPreparationStage =
    (typeof AdguardCliPreparationStage)[keyof typeof AdguardCliPreparationStage];

/**
 * Stable stage-bound limitation code.
 */
export type AdguardCliPreparationLimitationCode =
    (typeof AdguardCliPreparationLimitationCode)[keyof typeof AdguardCliPreparationLimitationCode];

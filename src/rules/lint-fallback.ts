/**
 * The vocabulary of a lint that did not run under the repository's configuration as written.
 *
 * Kept apart from `aglint-config-loader.ts` so a consumer that only needs to recognize or name a
 * fallback — the `lint_rule` tool result, the missing-information harvest — does not pull the
 * `@adguard/aglint` package in with it.
 */

/**
 * Why AGLint did not lint under the repository's configuration as written.
 */
export const LintConfigurationFallback = {
    /**
     * Neither the explicit repository root nor the discovery walk up from it supplied a
     * configuration file, so AGLint's defaults (every rule off) governed the lint.
     */
    NoRepositoryConfig: 'no-repository-config',

    /**
     * A configuration file was discovered, but the pinned AGLint's schema rejected it, so the
     * 4.0-era keys were stripped and the reduced remainder governed the lint.
     */
    StrippedRepositoryConfig: 'stripped-repository-config',
} as const;

/**
 * LintConfigurationFallback value.
 */
export type LintConfigurationFallback =
    (typeof LintConfigurationFallback)[keyof typeof LintConfigurationFallback];

/**
 * Every LintConfigurationFallback value, so a consumer can recognize any declared fallback without
 * enumerating the kinds itself.
 */
export const LINT_CONFIGURATION_FALLBACK_VALUES: readonly LintConfigurationFallback[] =
    Object.values(LintConfigurationFallback);

/**
 * The note a lint that found no repository configuration carries.
 */
export const NO_REPOSITORY_CONFIG_FALLBACK_MESSAGE =
    'No repository AGLint configuration was found, so only rule syntax was checked.';

/**
 * The note a lint under a reduced repository configuration carries.
 *
 * It names the consequence rather than the mechanism, because that is what a reader of the report
 * needs: AdguardFilters' own `.aglintrc` is 4.0-era and the pinned AGLint 3.0.3 rejects it, so the
 * retry drops `platforms` and the `no-excluded-rules` options — and a rule the repository
 * deliberately excludes, such as `||duckduckgo.com^$removeparam=atb`, then lints clean.
 */
export const STRIPPED_REPOSITORY_CONFIG_FALLBACK_MESSAGE =
    'The repository AGLint configuration was not accepted as written: its platform and ' +
    'excluded-rule settings were dropped, so a rule the repository excludes can still lint clean.';

/**
 * The note one lint carries when the repository's configuration did not govern it as written.
 */
export interface LintFallbackNote {
    /**
     * Why the fallback applied.
     */
    kind: LintConfigurationFallback;

    /**
     * The note carried into the run evidence and the report.
     */
    message: string;
}

/**
 * The note the default-config branches attach; one shared value so every consumer sees identical
 * prose.
 */
export const NO_REPOSITORY_CONFIG_FALLBACK: LintFallbackNote = {
    kind: LintConfigurationFallback.NoRepositoryConfig,
    message: NO_REPOSITORY_CONFIG_FALLBACK_MESSAGE,
};

/**
 * The note the compatibility-strip retry attaches once it constructs a linter.
 */
export const STRIPPED_REPOSITORY_CONFIG_FALLBACK: LintFallbackNote = {
    kind: LintConfigurationFallback.StrippedRepositoryConfig,
    message: STRIPPED_REPOSITORY_CONFIG_FALLBACK_MESSAGE,
};

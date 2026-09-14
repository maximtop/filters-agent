import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Linter, type LinterConfig } from '@adguard/aglint';
import { parse as parseYaml } from 'yaml';
import type { Logger } from '../logger/logger';

/**
 * AGLint configuration discovery and load: the config-file walk, the 4.0-era compatibility strip,
 * and the per-repoRoot memoization backing `lintRule`. This module resolves an AGLint `Linter` for
 * a repository root; problem mapping stays in `aglint-linter.ts`.
 */

/**
 * File names AGLint recognizes as configuration files, mirroring the pinned package's CLI
 * `CONFIG_FILE_NAMES` constant so sync discovery selects exactly what AGLint's own loader would.
 */
const AGLINT_CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
    'aglint.config.json',
    'aglint.config.yaml',
    'aglint.config.yml',
    '.aglintrc',
    '.aglintrc.json',
    '.aglintrc.yaml',
    '.aglintrc.yml',
]);

/**
 * The extension-less AGLint config name; AGLint parses it as JSON, so sync discovery must too.
 */
const AGLINT_EXTENSIONLESS_RC_NAME = '.aglintrc';

/**
 * Mirror of AGLint's unexported `defaultLinterConfig`: inline configuration comments allowed, the
 * Common syntax, and every linter rule off — only parse failures are reported.
 */
const DEFAULT_LINTER_CONFIG: LinterConfig = {
    allowInlineConfig: true,
    syntax: ['Common'],
};

/**
 * Top-level configuration keys of AGLint 4.0.0-era configs that @adguard/aglint@3.0.3's config
 * schema (`linterConfigPropsSchema`) rejects as unknown. Stripped at load time so the live
 * AdguardFilters checkout lints under its own `extends` instead of throwing; see the
 * third-party-filter convergence pattern for the same degrade-to-subset trade.
 */
const UNSUPPORTED_TOP_LEVEL_CONFIG_KEYS = ['platforms'] as const;

/**
 * The one AGLint rule whose per-rule options gained 4.0-era keys; only its options object is
 * repaired, the severity binding is kept.
 */
const NO_EXCLUDED_RULES_RULE_NAME = 'no-excluded-rules';

/**
 * Option keys of `no-excluded-rules` that 3.0.3's rule schema rejects; the packaged rule only
 * supports `regexp-patterns`.
 */
const UNSUPPORTED_NO_EXCLUDED_RULES_OPTION_KEYS = [
    'excludedRuleTexts',
    'excludedRegExpPatterns',
] as const;

/**
 * The single `no-excluded-rules` option key 3.0.3 supports.
 */
const SUPPORTED_NO_EXCLUDED_RULES_OPTION_KEY = 'regexp-patterns';

/**
 * AGLint rule config entries are `[severity, options?]`arrays; index of the severity binding.
 */
const AGLINT_RULE_CONFIG_SEVERITY_INDEX = 0;

/**
 * AGLint rule config entry index of the per-rule options object.
 */
const AGLINT_RULE_CONFIG_OPTIONS_INDEX = 1;

/**
 * Why AGLint linted without a repository configuration.
 */
export const LintConfigurationFallback = {
    /**
     * Neither the explicit repository root nor the discovery walk up from it supplied a
     * configuration file, so AGLint's defaults (every rule off) governed the lint.
     */
    NoRepositoryConfig: 'no-repository-config',
} as const;

/**
 * LintConfigurationFallback value.
 */
export type LintConfigurationFallback =
    (typeof LintConfigurationFallback)[keyof typeof LintConfigurationFallback];

/**
 * The note the syntax-only fallback carries into the run evidence and the report.
 */
export const LINT_CONFIGURATION_FALLBACK_MESSAGE =
    'No repository AGLint configuration was found, so only rule syntax was checked.';

/**
 * The syntax-only fallback one lint carries when no repository configuration governed it.
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
 * The one fallback note the default-config branches attach; one shared value so every consumer sees
 * identical prose.
 */
const NO_REPOSITORY_CONFIG_FALLBACK: LintFallbackNote = {
    kind: LintConfigurationFallback.NoRepositoryConfig,
    message: LINT_CONFIGURATION_FALLBACK_MESSAGE,
};

/**
 * A lint environment resolved to a constructed AGLint linter.
 */
interface ResolvedLinter {
    /**
     * Discriminator for the resolved branch.
     */
    ok: true;

    /**
     * The memoized AGLint linter instance; reusable across `lint` calls.
     */
    linter: Linter;

    /**
     * The syntax-only fallback note when AGLint's defaults governed because no repository
     * configuration was found; absent when a discovered configuration governed.
     */
    fallback?: LintFallbackNote;
}

/**
 * A config-resolution failure that replaces the missing linter.
 */
interface FailedResolution {
    /**
     * Discriminator for the failed branch.
     */
    ok: false;

    /**
     * The caught and logged error, mapped to a `config-error` problem on every subsequent lint.
     */
    error: Error;
}

/**
 * One resolved lint environment: either a constructed AGLint linter or the config failure that
 * replaced it. Memoized per `repoRoot` so one run resolves the configuration once.
 */
export type PreparedLint = ResolvedLinter | FailedResolution;

/**
 * One parsed configuration file on the discovery walk.
 */
interface LoadedConfigFile {
    /**
     * Exact file path the configuration was parsed from (kept for diagnostics).
     */
    path: string;

    /**
     * Parsed configuration object; typed loosely because YAML/JSON content is scheme-checked by
     * AGLint itself when the `Linter` is constructed.
     */
    config: Record<string, unknown>;
}

/**
 * Memoized linters per repository root, keyed by the exact `repoRoot` string.
 */
const preparedByRepoRoot = new Map<string, PreparedLint>();

/**
 * Memoized lint environment for the pathless (defaults) call.
 */
let defaultPreparedLint: PreparedLint | undefined;

/**
 * Whether a value is a plain object (not an array, not null) and can be deep-merged.
 *
 * @param value - Any parsed JSON/YAML value.
 * @returns Whether the value is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge one extending AGLint configuration into an initial one, mirroring AGLint's internal
 * `mergeConfigs` (deepmerge with the source array replacing the target array): plain objects merge
 * recursively, everything else — including arrays — is taken from the extending config.
 *
 * @param initial - Configuration being extended (the config closer to the repository root).
 * @param extend - Extending configuration (the config closer to the linted directory).
 * @returns The merged configuration, inputs left untouched.
 */
function mergeAglintConfigs(
    initial: Record<string, unknown>,
    extend: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...initial };
    for (const [key, extendValue] of Object.entries(extend)) {
        const initialValue = merged[key];
        if (isPlainObject(initialValue) && isPlainObject(extendValue)) {
            merged[key] = mergeAglintConfigs(initialValue, extendValue);
        } else {
            merged[key] = extendValue;
        }
    }
    return merged;
}

/**
 * Parse the contents of one AGLint configuration file, mirroring AGLint's own `parseConfigFile`
 * format rules: the extension-less `.aglintrc` is JSON, the other supported names are JSON or YAML
 * by extension.
 *
 * @param path - Exact configuration file path.
 * @returns The parsed configuration object.
 * @throws When the file cannot be read, parsed, or is not a mapping.
 */
function parseConfigFileContents(path: string): Record<string, unknown> {
    const contents = readFileSync(path, 'utf8');
    const base = path.split('/').pop() ?? path;
    let parsed: unknown;
    if (base === AGLINT_EXTENSIONLESS_RC_NAME || base.endsWith('.json')) {
        parsed = JSON.parse(contents);
    } else {
        parsed = parseYaml(contents);
    }
    if (!isPlainObject(parsed)) {
        throw new Error(`AGLint config file "${path}" must contain a mapping`);
    }
    return parsed;
}

/**
 * Walk up from the repository root and collect every AGLint configuration file until a `root: true`
 * configuration is honored or the filesystem root is reached, mirroring AGLint's own walk-up
 * semantics. Exactly one config file per directory is allowed, like AGLint's `configFinder`.
 *
 * @param repoRoot - Directory to start the walk from.
 * @returns The loaded chain in walk order (leaf first, root-honoring config last).
 * @throws When one directory holds several config files or a file fails to parse.
 */
function loadConfigChain(repoRoot: string): LoadedConfigFile[] {
    const chain: LoadedConfigFile[] = [];
    let current = resolve(repoRoot);
    do {
        const entries = readdirSync(current).filter((name) => AGLINT_CONFIG_FILE_NAMES.has(name));
        if (entries.length > 1) {
            throw new Error(`Multiple config files found in ${current}`);
        }
        if (entries.length === 1) {
            const path = join(current, entries[0]!);
            const config = parseConfigFileContents(path);
            chain.push({ path, config });
            if (config['root'] === true) {
                break;
            }
        }
        current = dirname(current);
    } while (current !== dirname(current));
    return chain;
}

/**
 * Repair one parsed configuration by removing the keys @adguard/aglint@3.0.3's schemas reject,
 * degrading the excluded-rule allowlist to the supported `regexp-patterns` subset. No value is ever
 * mapped: unsupported means dropped.
 *
 * @param config - The parsed configuration.
 * @returns A configuration the 3.0.3 schema accepts; the input is left untouched.
 */
function stripUnsupportedConfigKeys(config: Record<string, unknown>): Record<string, unknown> {
    const stripped: Record<string, unknown> = { ...config };
    for (const key of UNSUPPORTED_TOP_LEVEL_CONFIG_KEYS) {
        delete stripped[key];
    }

    const rules = stripped['rules'];
    if (!isPlainObject(rules)) {
        return stripped;
    }
    const nextRules: Record<string, unknown> = { ...rules };
    const noExcludedRuleConfig = nextRules[NO_EXCLUDED_RULES_RULE_NAME];
    if (
        Array.isArray(noExcludedRuleConfig) &&
        noExcludedRuleConfig.length > AGLINT_RULE_CONFIG_OPTIONS_INDEX &&
        isPlainObject(noExcludedRuleConfig[AGLINT_RULE_CONFIG_OPTIONS_INDEX])
    ) {
        const rawOptions = noExcludedRuleConfig[AGLINT_RULE_CONFIG_OPTIONS_INDEX] as Record<
            string,
            unknown
        >;
        const supportedOptions: Record<string, unknown> = {};
        if (Array.isArray(rawOptions[SUPPORTED_NO_EXCLUDED_RULES_OPTION_KEY])) {
            supportedOptions[SUPPORTED_NO_EXCLUDED_RULES_OPTION_KEY] =
                rawOptions[SUPPORTED_NO_EXCLUDED_RULES_OPTION_KEY];
        } else {
            // The packaged rule's own default: an empty supported allowlist, which is exactly the
            // degrade-to-subset outcome of dropping the 4.0-era option keys.
            supportedOptions[SUPPORTED_NO_EXCLUDED_RULES_OPTION_KEY] = [];
        }
        for (const key of UNSUPPORTED_NO_EXCLUDED_RULES_OPTION_KEYS) {
            delete rawOptions[key];
        }
        nextRules[NO_EXCLUDED_RULES_RULE_NAME] = [
            noExcludedRuleConfig[AGLINT_RULE_CONFIG_SEVERITY_INDEX],
            { ...supportedOptions },
        ];
    }
    return { ...stripped, rules: nextRules };
}

/**
 * Construct a linter from one resolved configuration, retrying once over the 4.0-era compatibility
 * strip when the config schema rejects the discovered file.
 *
 * @param config - The merged discovered configuration.
 * @param repoRoot - Repository root, for diagnostics only.
 * @param logger - Diagnostics sink receiving the schema-rejection degradation.
 * @returns The prepared lint environment.
 */
function constructLinterWithCompatibilityStrip(
    config: Record<string, unknown>,
    repoRoot: string | undefined,
    logger: Logger,
): PreparedLint {
    try {
        return { ok: true, linter: new Linter(true, config as unknown as LinterConfig) };
    } catch (error) {
        logger.warn(
            { err: error, repoRoot },
            'AGLint schema rejected the discovered config; retrying after stripping 4.0-era keys',
        );
    }
    try {
        return {
            ok: true,
            linter: new Linter(true, stripUnsupportedConfigKeys(config) as unknown as LinterConfig),
        };
    } catch (stripError) {
        logger.error(
            { err: stripError, repoRoot },
            'AGLint config rejected even after stripping 4.0-era keys',
        );
        return { ok: false, error: stripError as Error };
    }
}

/**
 * Resolve the lint environment for one repository root: walk up, merge the config chain, construct
 * the linter with the compatibility strip, and map any failure to the config-error channel. Never
 * throws.
 *
 * @param repoRoot - Repository root to resolve the configuration from.
 * @param logger - Diagnostics sink for degradations and failures.
 * @returns The prepared lint environment.
 */
function resolvePreparedLint(repoRoot: string | undefined, logger: Logger): PreparedLint {
    if (repoRoot === undefined) {
        try {
            return {
                ok: true,
                linter: new Linter(true, DEFAULT_LINTER_CONFIG),
                fallback: NO_REPOSITORY_CONFIG_FALLBACK,
            };
        } catch (error) {
            logger.error({ err: error }, 'AGLint default config failed to construct');
            return { ok: false, error: error as Error };
        }
    }
    try {
        const chain = loadConfigChain(repoRoot);
        if (chain.length === 0) {
            return {
                ok: true,
                linter: new Linter(true, DEFAULT_LINTER_CONFIG),
                fallback: NO_REPOSITORY_CONFIG_FALLBACK,
            };
        }
        // Walk order is leaf → root; the root → leaf fold lets the leaf-ward config extend the
        // root one, exactly like AGLint's own `buildConfigForDirectory`.
        let mergedConfig: Record<string, unknown> = {};
        for (let i = chain.length - 1; i >= 0; i -= 1) {
            mergedConfig = mergeAglintConfigs(mergedConfig, chain[i]!.config);
        }
        return constructLinterWithCompatibilityStrip(mergedConfig, repoRoot, logger);
    } catch (error) {
        logger.error({ err: error, repoRoot }, 'AGLint config discovery failed');
        return { ok: false, error: error as Error };
    }
}

/**
 * Return the memoized lint environment for one repository root, resolving it on first use. The
 * config-error failure is memoized too, so a broken config fails once and identically after that.
 *
 * @param repoRoot - Repository root or undefined for the pathless defaults.
 * @param logger - Diagnostics sink used by the first resolution.
 * @returns The prepared lint environment.
 */
export function getPreparedLint(repoRoot: string | undefined, logger: Logger): PreparedLint {
    if (repoRoot === undefined) {
        defaultPreparedLint ??= resolvePreparedLint(undefined, logger);
        return defaultPreparedLint;
    }
    const cached = preparedByRepoRoot.get(repoRoot);
    if (cached) {
        return cached;
    }
    const prepared = resolvePreparedLint(repoRoot, logger);
    preparedByRepoRoot.set(repoRoot, prepared);
    return prepared;
}

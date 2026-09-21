import { type LinterProblem as AglintLinterProblem } from '@adguard/aglint';
import { createLogger, type Logger } from '../logger/logger';
import { getPreparedLint, type PreparedLint } from './aglint-config-loader';
import type { LintFallbackNote } from './lint-fallback';
import { parseSafeCssInjectionRule } from './safe-css-injection';

/**
 * AGLint-backed linter wrapper for a single filter-list rule: the lint contract, the problem
 * mapping, and the wrapper-owned shape checks AGLint itself does not perform. Configuration
 * discovery and load live in `aglint-config-loader.ts`.
 */

/**
 * Severity of a single problem reported while linting a filter-list rule.
 */
export const LintSeverity = { Error: 'error', Warning: 'warning' } as const;

/**
 * Severity of a single problem reported while linting a filter-list rule.
 */
export type LintSeverity = (typeof LintSeverity)[keyof typeof LintSeverity];

/**
 * Location of a lint problem inside the linted rule text, passed through from AGLint verbatim.
 */
export interface LintPosition {
    /**
     * 1-based line number where the problem starts.
     */
    startLine: number;

    /**
     * 0-based column number where the problem starts.
     */
    startColumn: number;

    /**
     * 1-based line number where the problem ends.
     */
    endLine: number;

    /**
     * 0-based column number where the problem ends.
     */
    endColumn: number;
}

/**
 * A single problem reported while linting a filter-list rule with AGLint.
 */
export interface LintProblem {
    /**
     * 'error' (invalid syntax or config failure) or 'warning' (suboptimal but parseable).
     */
    severity: LintSeverity;

    /**
     * AGLint's rule id for rule problems, 'syntax-error' for parse failures without a rule,
     * 'config-error' when the repository's AGLint configuration could not be resolved, or
     * 'css-with-scriptlet-separator' for the wrapper-owned separator shape check.
     */
    code: string;

    /**
     * AGLint's human-readable explanation, passed through verbatim (except for the wrapper-owned
     * separator problem, which carries the old linter's message).
     */
    message: string;

    /**
     * AGLint's problem position when the problem belongs to the linted rule text; absent for
     * config-level failures and the wrapper-owned separator problem.
     */
    position?: LintPosition;
}

/**
 * The outcome of linting a single filter-list rule with AGLint.
 */
export interface LintResult {
    /**
     * True when there are zero error-severity problems.
     */
    valid: boolean;

    /**
     * The problems detected (warnings and errors), in detection order.
     */
    problems: LintProblem[];

    /**
     * The fallback note when the repository's configuration did not govern the lint as written —
     * none was found, or the pinned AGLint rejected it and the strip retry reduced it; absent when
     * a discovered configuration governed as written.
     */
    fallback?: LintFallbackNote;
}

/**
 * Options for linting one rule.
 */
export interface LintRuleOptions {
    /**
     * Root of the repository whose AGLint configuration (`.aglintrc` family, walked up and honored
     * through `root: true`) governs the lint. Omitted means AGLint's defaults.
     */
    repoRoot?: string;

    /**
     * Diagnostics sink for config-resolution degradations and failures; the resolved linter is
     * memoized per `repoRoot`, so only the first call for a root logs. Defaults to the application
     * logger.
     */
    logger?: Logger;
}

/**
 * Problem code for CSS declarations written with the #%# JavaScript-injection separator. AGLint
 * accepts that spelling (the re-spelled `#$#` form parses as a valid CSS injection), the old
 * hand-rolled linter refused it as an error, and the wrapper re-emits exactly that problem.
 */
export const CSS_WITH_SCRIPTLET_SEPARATOR_CODE = 'css-with-scriptlet-separator';

/**
 * The #%# separator: JavaScript-injection syntax, refused for CSS declarations.
 */
const SCRIPTLET_SEPARATOR = '#%#';

/**
 * The #$# separator: the CSS-injection spelling corrections must be re-spelled with.
 */
const CSS_INJECTION_SEPARATOR = '#$#';

/**
 * The old linter's verbatim message for the separator mis-spelling, kept identical so every caller
 * sees the same correction text the hand-rolled linter produced.
 */
const CSS_WITH_SCRIPTLET_SEPARATOR_MESSAGE =
    'CSS declarations must use the #$# CSS injection separator; ' +
    '#%# is JavaScript injection syntax.';

/**
 * Code assigned to parse failures AGLint reports without a rule name (severity `fatal`).
 */
const SYNTAX_ERROR_CODE = 'syntax-error';

/**
 * Code assigned when the repository's AGLint configuration cannot be resolved or loaded.
 */
const CONFIG_ERROR_CODE = 'config-error';

/**
 * AGLint severity values (the wire form its `LinterResult` problems carry): 2 = error, 3 = fatal.
 */
const AGLINT_ERROR_SEVERITY_VALUE = 2;

/**
 * AGLint fatal severity value; parse failures report it without a rule name.
 */
const AGLINT_FATAL_SEVERITY_VALUE = 3;

/**
 * Detect CSS declarations written with the #%# JavaScript-injection separator and map them to the
 * old linter's `css-with-scriptlet-separator` error. AGLint (preset or defaults) accepts that
 * spelling, so the wrapper owns the shape check: the rule re-spelled with `#$#` must parse as a
 * valid CSS injection through the one shared parser for the mis-spelling to be flaggable, which
 * keeps genuine `#%#` scriptlets and comments unflagged. Like the old `pushError` shape, the
 * problem carries no position.
 *
 * @param rule - A single raw filter-list rule line.
 * @returns The old separator problem, or undefined when the rule is not a `#%#`-spelled CSS
 *   declaration.
 */
function detectCssWithScriptletSeparator(rule: string): LintProblem | undefined {
    if (!rule.includes(SCRIPTLET_SEPARATOR)) {
        return undefined;
    }
    const cssEquivalent = rule.replace(SCRIPTLET_SEPARATOR, CSS_INJECTION_SEPARATOR);
    if (parseSafeCssInjectionRule(cssEquivalent).value === undefined) {
        return undefined;
    }
    return {
        severity: LintSeverity.Error,
        code: CSS_WITH_SCRIPTLET_SEPARATOR_CODE,
        message: CSS_WITH_SCRIPTLET_SEPARATOR_MESSAGE,
    };
}

/**
 * Normalize one AGLint severity (numeric value or name) onto the lint contract's severity.
 *
 * @param severity - The raw AGLint severity of a problem.
 * @returns 'error' for error and fatal severities, 'warning' otherwise.
 */
function mapSeverity(severity: string | number): LintSeverity {
    if (
        severity === 'error' ||
        severity === 'fatal' ||
        severity === AGLINT_ERROR_SEVERITY_VALUE ||
        severity === AGLINT_FATAL_SEVERITY_VALUE
    ) {
        return LintSeverity.Error;
    }
    return LintSeverity.Warning;
}

/**
 * Map one AGLint problem onto the lint contract, passing the message and position through verbatim
 * (AC3: the result carries AGLint's position and message).
 *
 * @param problem - The AGLint problem to map.
 * @returns The contract problem with AGLint's rule id (or the syntax-error code) and position.
 */
function mapAglintProblem(problem: AglintLinterProblem): LintProblem {
    return {
        severity: mapSeverity(problem.severity),
        code: problem.rule ?? SYNTAX_ERROR_CODE,
        message: problem.message,
        position: { ...problem.position },
    };
}

/**
 * Map one config-resolution failure onto the contract's terminal error problem after the caught
 * error has been logged: error severity, the AGLint message, no position, `valid: false`.
 *
 * @param error - The logged config error.
 * @returns The config-error problem.
 */
function mapConfigError(error: Error): LintProblem {
    return {
        severity: LintSeverity.Error,
        code: CONFIG_ERROR_CODE,
        message: error.message,
    };
}

/**
 * Validate the syntax of a single filter-list rule with AGLint under the repository's own
 * configuration.
 *
 * The configuration is discovered by walking up from `repoRoot` (honoring `root: true`, one config
 * file per directory, exactly like AGLint's own loader) and is memoized per root: one run resolves
 * the config once. With no repository root — or no config file on the walk — AGLint's defaults
 * apply (every rule off, parse failures still reported) and the result carries the syntax-only
 * fallback note that says so. A live 4.0-era configuration (as currently shipped by AdguardFilters
 * master) is repaired at load time by stripping the keys the pinned 3.0.3 package rejects, and the
 * result carries its own fallback note saying the configuration was reduced; every degradation or
 * failure is logged first. Discovery and load failures never throw out of this function: they
 * surface as an error-severity `config-error` problem.
 *
 * Before the AGLint call, the wrapper runs the `css-with-scriptlet-separator` shape check: CSS
 * declarations spelled with the #%# JavaScript-injection separator are flagged exactly like the old
 * hand-rolled linter flagged them, independently of the resolved configuration.
 *
 * @param rule - A single raw filter-list rule line.
 * @param options - Repository root and diagnostics sink; both optional.
 * @returns The lint result with an overall validity flag, the list of problems, and the fallback
 *   note when the repository's configuration did not govern the lint as written.
 */
export function lintRule(rule: string, options?: LintRuleOptions): LintResult {
    const logger = options?.logger ?? createLogger();
    const problems: LintProblem[] = [];
    const separatorProblem = detectCssWithScriptletSeparator(rule);
    if (separatorProblem) {
        problems.push(separatorProblem);
    }
    const prepared: PreparedLint = getPreparedLint(options?.repoRoot, logger);
    if (!prepared.ok) {
        problems.push(mapConfigError(prepared.error));
    } else {
        problems.push(...prepared.linter.lint(rule).problems.map(mapAglintProblem));
    }
    return {
        valid: !problems.some((problem) => problem.severity === LintSeverity.Error),
        problems,
        ...(prepared.ok && prepared.fallback !== undefined ? { fallback: prepared.fallback } : {}),
    };
}

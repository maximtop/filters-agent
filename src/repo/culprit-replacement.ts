import { lintRule } from '../rules/aglint-linter';
import { normalizeRule, RuleKind, type NormalizedRule } from './rule-normalizer';

/**
 * Options for the single-actionable-rule predicate.
 */
interface SingleActionableRuleOptions {
    /**
     * Root of the repository whose AGLint configuration governs the lint; omitted means AGLint's
     * defaults, which the pure `describe*` descriptors use by design (their callers accepted the
     * same rule under the checkout config one gate above).
     */
    repoRoot?: string;
}

/**
 * The domain scope one exact culprit-rule replacement can affect.
 */
export interface CulpritReplacement {
    /**
     * Ascending domain scopes the original rule governed; empty when it carried no scope at all.
     */
    affectedScopes: readonly string[];
}

/**
 * Rule kinds a correction may be written in; a comment or a blank line corrects nothing.
 */
const ACTIONABLE_KINDS: ReadonlySet<NormalizedRule['kind']> = new Set([
    RuleKind.Network,
    RuleKind.Cosmetic,
    RuleKind.Scriptlet,
]);

/**
 * Decide whether a line is one well-formed rule that can take part in a correction.
 *
 * `lintRule` accepts a comment as valid, so the kind check rather than the lint result is what
 * refuses a line that is not an actionable rule at all. Exported so the culprit-edit gate refuses a
 * malformed line on exactly the terms this predicate would, rather than on a second definition that
 * could drift from it.
 *
 * @param rule - Raw candidate or repository line.
 * @param options - Optional repository root to lint under the checkout's AGLint configuration.
 * @returns Whether the line is a single actionable rule.
 */
export function isSingleActionableRule(
    rule: string,
    options?: SingleActionableRuleOptions,
): boolean {
    return (
        rule.length > 0 &&
        !/[\r\n]/u.test(rule) &&
        lintRule(rule, { repoRoot: options?.repoRoot }).valid &&
        ACTIONABLE_KINDS.has(normalizeRule(rule).kind)
    );
}

/**
 * The two halves of one rule's domain list, which are compared in opposite directions.
 */
interface PartitionedScopes {
    /**
     * Ascending scopes the rule serves.
     */
    positive: string[];

    /**
     * Ascending `~`-prefixed scopes the rule excludes.
     */
    negated: string[];
}

/**
 * Split a normalized domain list into the scopes a rule serves and the scopes it excludes.
 *
 * A `~`-prefixed scope subtracts from what the rule reaches, so the two halves must be compared in
 * opposite directions: a positive scope may only be lost, a negation may only be gained.
 *
 * @param rule - Normalized rule whose domain list is being partitioned.
 * @returns Ascending positive scopes and ascending negated scopes.
 */
function partitionScopes(rule: NormalizedRule): PartitionedScopes {
    return {
        positive: rule.domains.filter((domain) => !domain.startsWith('~')),
        negated: rule.domains.filter((domain) => domain.startsWith('~')),
    };
}

/**
 * Decide whether a complete replacement line is a safe correction of one exact existing rule.
 *
 * This is the sole definition of the exact-edit invariant. It deliberately does not judge the rule
 * expression: no structural check can prove a narrowed selector or URL pattern is right for the
 * domains the run never visited. What it does prove is that the change cannot reach further than
 * the rule already did — same kind, same concrete syntax, same polarity, no positive scope the
 * original did not already serve, and no negation the original carried thrown away — so the scopes
 * it returns are a complete bound on the blast radius the report must disclose.
 *
 * A rule that carried no positive scope at all already governs every site, so narrowing it to any
 * scope cannot broaden it; the empty disclosure is what the report renders as "every site this rule
 * matches".
 *
 * @param originalRule - Exact existing rule being corrected.
 * @param replacementRule - Complete replacement line.
 * @returns The scope disclosure when the replacement is a safe correction, else null.
 */
export function describeCulpritReplacement(
    originalRule: string,
    replacementRule: string,
): CulpritReplacement | null {
    if (!isSingleActionableRule(originalRule) || !isSingleActionableRule(replacementRule)) {
        return null;
    }
    const original = normalizeRule(originalRule);
    const replacement = normalizeRule(replacementRule);
    const originalScopes = partitionScopes(original);
    const replacementScopes = partitionScopes(replacement);
    if (
        original.kind !== replacement.kind ||
        original.syntaxKind !== replacement.syntaxKind ||
        original.isException ||
        replacement.isException ||
        original.canonical === replacement.canonical ||
        (originalScopes.positive.length > 0 &&
            !replacementScopes.positive.every((scope) =>
                originalScopes.positive.includes(scope),
            )) ||
        !originalScopes.negated.every((scope) => replacementScopes.negated.includes(scope))
    ) {
        return null;
    }
    // `normalizeRule` already lowercases, dedupes, and sorts every domain list, so the affected
    // scopes are ascending without re-sorting them here.
    return { affectedScopes: originalScopes.positive };
}

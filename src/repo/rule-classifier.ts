import type { SearchQuery } from '../types/repo-context';
import { DuplicateClass } from '../types/rule-proposal';
import type { NormalizedRule } from './rule-normalizer';
import { RuleKind } from './rule-normalizer';
import { domainScopeCovers, hostnameAndParentSuffixes } from './domain-scope';

/**
 * Build a synthetic candidate rule from a search query for comparison.
 *
 * @param query - The search query (selector/urlPattern/scriptlet + optional domain).
 * @returns A partial normalized rule describing the candidate, or undefined if no target.
 */
function candidateFromQuery(query: SearchQuery): Partial<NormalizedRule> | undefined {
    if (query.selector !== undefined) {
        return {
            kind: RuleKind.Cosmetic,
            selector: query.selector.trim(),
            domains: query.domain ? [query.domain.toLowerCase()] : [],
            isException: false,
            canonical: `${query.domain ? query.domain.toLowerCase() : ''}##${query.selector.trim()}`,
        };
    }
    if (query.urlPattern !== undefined) {
        const pattern = query.urlPattern.toLowerCase();
        const domains = query.domain ? [query.domain.toLowerCase()] : [];
        const modifiers = query.domain ? [`domain=${query.domain.toLowerCase()}`] : [];
        return {
            kind: RuleKind.Network,
            urlPattern: pattern,
            domains,
            modifiers,
            isException: false,
            canonical: pattern + (modifiers.length > 0 ? `$${modifiers.join(',')}` : ''),
        };
    }
    if (query.scriptlet !== undefined) {
        return {
            kind: RuleKind.Scriptlet,
            scriptletName: query.scriptlet,
            domains: query.domain ? [query.domain.toLowerCase()] : [],
            isException: false,
            canonical: `${query.domain ? query.domain.toLowerCase() : ''}#%#${query.scriptlet}`,
        };
    }
    return undefined;
}

/**
 * Determine whether an explicitly scoped rule applies to the requested site domain.
 *
 * Positive scopes cover the requested domain per {@link domainScopeCovers}, so an entity scope
 * (`shellshock.*`) covers the requested domain under whichever public suffix it was reported on.
 *
 * @param scopes - Normalized rule domain scopes, including possible `~` exclusions.
 * @param domain - Requested site domain.
 * @returns True when a positive scope covers the requested domain.
 */
function domainScopesApply(scopes: string[], domain: string): boolean {
    return scopes.some((scope) => {
        if (scope.startsWith('~')) {
            return false;
        }
        return domainScopeCovers(scope, domain);
    });
}

/**
 * Determine whether a rule belongs in a domain-only applicability inventory.
 *
 * Domain-only search intentionally does not synthesize a network blocking candidate. It returns
 * explicitly scoped cosmetic/scriptlet rules and network rules whose pattern or domain modifier
 * mentions the requested site.
 *
 * @param domain - Requested site domain.
 * @param existing - Existing normalized repository rule.
 * @returns True when the rule is relevant to the domain inventory.
 */
function isDomainInventoryMatch(domain: string, existing: NormalizedRule): boolean {
    const normalizedDomain = domain.toLowerCase();
    if (domainScopesApply(existing.domains, normalizedDomain)) {
        return true;
    }
    if (existing.kind !== RuleKind.Network || !existing.urlPattern) {
        return false;
    }
    const pattern = existing.urlPattern.toLowerCase();
    return hostnameAndParentSuffixes(normalizedDomain).some((host) => pattern.includes(host));
}

/**
 * Whether two normalized rules target the same element (pattern/selector/scriptlet).
 *
 * @param a - First rule.
 * @param b - Second rule.
 * @returns True if both target the same selector, URL pattern, or scriptlet name.
 */
function sameTarget(a: NormalizedRule, b: NormalizedRule): boolean {
    if (a.kind === RuleKind.Cosmetic && b.kind === RuleKind.Cosmetic) {
        return a.selector === b.selector;
    }
    if (a.kind === RuleKind.Network && b.kind === RuleKind.Network) {
        return a.urlPattern === b.urlPattern;
    }
    if (a.kind === RuleKind.Scriptlet && b.kind === RuleKind.Scriptlet) {
        return a.scriptletName === b.scriptletName;
    }
    return false;
}

/**
 * Whether the existing rule's scope is a superset of the candidate's (existing is more general).
 *
 * "Subsumed" here means "subsumed-by-generic": the existing rule is broader than the candidate — it
 * is generic (no domain restriction) or has fewer network modifiers. An existing rule that merely
 * lists additional domains is NOT treated as subsuming the candidate.
 *
 * @param existing - The rule already in the checkout.
 * @param candidate - The candidate rule from the query.
 * @returns True if existing covers candidate's scope without extra restrictions.
 */
function isMoreGeneral(existing: NormalizedRule, candidate: NormalizedRule): boolean {
    // Generic (empty domains) existing vs domain-specific candidate.
    if (existing.domains.length === 0 && candidate.domains.length > 0) {
        return true;
    }
    // Network: existing has a subset of candidate's modifiers (fewer restrictions).
    if (existing.kind === RuleKind.Network && candidate.kind === RuleKind.Network) {
        const existingMods = existing.modifiers.filter((m) => !m.startsWith('domain='));
        const candidateMods = candidate.modifiers.filter((m) => !m.startsWith('domain='));
        if (existingMods.length < candidateMods.length) {
            return true;
        }
    }
    return false;
}

/**
 * Whether two domain lists contain the same set of domains.
 *
 * @param a - First domain list.
 * @param b - Second domain list.
 * @returns True if both lists hold the same domains.
 */
function domainsEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((d) => b.includes(d));
}

/**
 * Classify how an existing rule relates to a candidate rule described by the search query.
 *
 * Returns `'none'` when the rules do not share a target. The `'cross-filter'` class is assigned at
 * the search level (it requires cross-file context) and is never returned here.
 *
 * @param query - The candidate rule target (selector/urlPattern/scriptlet + optional domain).
 * @param existing - The normalized form of an existing rule in the checkout.
 * @returns The similarity class.
 */
export function classifyMatch(query: SearchQuery, existing: NormalizedRule): DuplicateClass {
    if (
        query.domain !== undefined &&
        query.selector === undefined &&
        query.urlPattern === undefined &&
        query.scriptlet === undefined
    ) {
        return isDomainInventoryMatch(query.domain, existing)
            ? DuplicateClass.Semantic
            : DuplicateClass.None;
    }
    const candidatePartial = candidateFromQuery(query);
    if (candidatePartial === undefined) {
        return DuplicateClass.None;
    }
    const candidate = candidatePartial as NormalizedRule;
    if (!sameTarget(candidate, existing)) {
        return DuplicateClass.None;
    }
    if (candidate.isException !== existing.isException) {
        return DuplicateClass.Conflict;
    }
    // Scriptlet exactness is by name + domain set: the query candidate carries
    // only the scriptlet name, so it can never string-match the full scriptlet
    // body canonical. Match on name + domains instead.
    if (
        candidate.kind === RuleKind.Scriptlet &&
        existing.kind === RuleKind.Scriptlet &&
        domainsEqual(candidate.domains, existing.domains)
    ) {
        return DuplicateClass.Exact;
    }
    if (candidate.canonical === existing.canonical) {
        return DuplicateClass.Exact;
    }
    if (isMoreGeneral(existing, candidate)) {
        return DuplicateClass.Subsumed;
    }
    return DuplicateClass.Semantic;
}

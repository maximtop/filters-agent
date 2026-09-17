/**
 * Whether a phase's `appliedRules` record names exactly the given rules.
 *
 * `appliedRules` is a second, redundant projection of what a phase ran: the ordered truth is the
 * `ruleApplications` ledger, which the verdict checks rule by rule against the trusted input. The
 * two readers of `appliedRules` used to demand two different orders of it — the verdict the legacy
 * in-page applicator's chronology (network rules first, then the rest), the rejected-evidence check
 * the plain input order — while the environment-adapter route, the only validator a fix session
 * has, writes input order. A domain whose trusted rules interleave kinds could therefore never be
 * verified: nottinghampost.com carries a cosmetic rule between network ones, and a vision-verified
 * candidate was refused with "a phase rule-application ledger does not partition the trusted
 * rules". Order is a producer's detail; membership is the provenance fact, so membership is what
 * both readers ask, from here.
 *
 * @param value - Unknown applied-rule field from the factual payload.
 * @param expected - Exactly the rules the phase must have applied; duplicate-free.
 * @returns Whether `value` is an array holding each expected rule once and nothing else.
 */
export function appliedRulesMatch(value: unknown, expected: readonly string[]): boolean {
    if (!Array.isArray(value) || value.length !== expected.length) {
        return false;
    }
    const applied = new Set<unknown>(value);
    return applied.size === value.length && expected.every((rule) => applied.has(rule));
}

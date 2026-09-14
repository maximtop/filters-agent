import type { PolicyGateInput, PolicyDecision } from '../types/policy';

/**
 * Determine whether the supplied evidence references contain Level-1 evidence.
 *
 * A HAR capture is the strongest direct evidence available and is treated as Level-1; the token
 * `'level-1'` is also accepted. Matching is case-insensitive. When none of the references match,
 * Level-1 evidence is considered missing.
 *
 * @param evidenceRefs - The evidence reference strings gathered for the issue.
 * @returns `true` when at least one reference denotes Level-1 evidence.
 */
function hasLevelOneEvidence(evidenceRefs: string[]): boolean {
    return evidenceRefs.some((ref) => {
        const lower = ref.toLowerCase();
        return lower.includes('har') || lower.includes('level-1');
    });
}

/**
 * Evaluate filter policy against a policy-gate input and return a deterministic decision.
 *
 * The decision table is evaluated in precedence order — most restrictive first, first match wins:
 *
 * 1. First-party ad → `propose_close`
 * 2. Paywall → `propose_close`
 * 3. German anti-adblock → `propose_close`
 * 4. Anti-adblock wall without Level-1 evidence → `needs_human_review`
 * 5. Otherwise → `allow_rule_generation`
 *
 * The LLM never produces this decision; it only helps populate `PolicyGateInput`.
 *
 * @param input - The validated policy-gate input.
 * @returns The deterministic policy decision with cited reasons.
 */
export function policyCheck(input: PolicyGateInput): PolicyDecision {
    if (input.firstPartyAd) {
        return {
            decision: 'propose_close',
            reasons: ["site's own advertising"],
        };
    }

    if (input.paywall) {
        return {
            decision: 'propose_close',
            reasons: ['paywall-like content'],
        };
    }

    if (input.germanAntiAdblock) {
        return {
            decision: 'propose_close',
            reasons: ['German anti-adblock — management decision'],
        };
    }

    if (input.antiAdblockWall && !hasLevelOneEvidence(input.evidenceRefs)) {
        return {
            decision: 'needs_human_review',
            reasons: ['anti-adblock wall without Level-1 evidence'],
        };
    }

    return {
        decision: 'allow_rule_generation',
        reasons: ['no policy blockers'],
    };
}

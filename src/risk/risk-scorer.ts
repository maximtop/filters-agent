import { RequiredAction, RiskLevel, type RuleRisk } from '../types/rule-proposal';
import { RuleKind, effectiveRuleScopes, normalizeRule } from '../repo/rule-normalizer';

/**
 * Optional blast-radius hints supplied by the caller.
 *
 * These are not derived from the rule string itself; they come from external analysis (e.g. the
 * evidence pack) and are surfaced as informational blast-radius flags without changing the
 * deterministic score.
 */
export interface ScoreRiskOptions {
    /**
     * Runner-bound issue hostname used to recognize an exact first-party network path. This must
     * never be copied from model-controlled tool arguments.
     */
    trustedReportedDomain?: string;

    /**
     * Whether the rule is suspected to affect more than one known site. `null`/`undefined` =
     * unknown.
     */
    affectsMultipleKnownSites?: boolean | null;

    /**
     * Whether the rule is suspected to remove a large DOM subtree. `null`/`undefined` = unknown.
     */
    removesLargeDomSubtree?: boolean | null;
}

/**
 * Sensitive-area keywords that, when present anywhere in a rule, raise its risk.
 */
const SENSITIVE_KEYWORDS = ['auth', 'login', 'payment', 'checkout', 'player', 'video'];

/**
 * Map a clamped 0-5 risk score to its qualitative level.
 *
 * @param score - The clamped integer score in the inclusive range [0, 5].
 * @returns The risk level label.
 */
function levelForScore(score: number): RuleRisk['level'] {
    if (score <= 1) {
        return RiskLevel.Low;
    }
    if (score === 2) {
        return RiskLevel.Medium;
    }
    if (score <= 4) {
        return RiskLevel.High;
    }
    return RiskLevel.Blocker;
}

/**
 * Map a risk level to the required follow-up action the agent must take.
 *
 * @param level - The qualitative risk level.
 * @returns The required action for a rule of this level.
 */
function actionForLevel(level: RuleRisk['level']): RuleRisk['requiredAction'] {
    if (level === RiskLevel.Low) {
        return RequiredAction.AutoPr;
    }
    if (level === RiskLevel.Medium) {
        return RequiredAction.PrWithWarning;
    }
    return RequiredAction.HumanOnly;
}

/**
 * Compute a deterministic risk assessment for a single AdGuard filter rule.
 *
 * The rule is first normalized via {@link normalizeRule}; its kind, domain scope, selector and
 * modifiers are then matched against a fixed rule table. Each match adds to an integer score and
 * pushes a human-readable reason plus a blast-radius flag. A domain-restricted rule receives a
 * baseline of 1 (the lowest non-zero floor) - this is a scope signal, not an extra danger. The
 * accumulated score is clamped to [0, 5]; an unclassifiable rule (score 0) defaults to score 1 /
 * level `low`.
 *
 * Scoring rules (additive):
 *
 * 1. Generic cosmetic selector with no domain -> +3, flag `genericSelector`;
 * 2. Bare network block with no trusted effective scope -> +3, flag `thirdPartyDomainRule`;
 * 3. Broad attribute-match selector (`*=`) -> +1, flag `broadSelector`;
 * 4. Scriptlet -> +1 flag `usesScriptlet`; `$script` modifier -> +1 flag `blocksScript`;
 * 5. Generic exception rule with no domain -> +3, flag `exceptionRule`;
 * 6. Touches a sensitive area (auth/login/payment/checkout/player/video) -> +3, flag
 *    `touchesSensitiveArea`.
 *
 * Level mapping: 0-1 low, 2 medium, 3-4 high, 5 blocker. Required action: low -> `auto_pr`, medium
 * -> `pr_with_warning`, high/blocker -> `human_only`.
 *
 * @param rule - The raw filter rule line to assess.
 * @param options - Optional caller-supplied blast-radius hints.
 * @returns The deterministic {@link RuleRisk} assessment.
 */
export function scoreRisk(rule: string, options?: ScoreRiskOptions): RuleRisk {
    const normalized = normalizeRule(rule);
    const reasons: string[] = [];
    const blastRadiusFlags: string[] = [];
    let score = 0;

    const isException = normalized.isException;
    const effectiveScopes = effectiveRuleScopes(normalized, options?.trustedReportedDomain);
    const isDomainRestricted = effectiveScopes.length > 0;

    // 1. Generic cosmetic selector with no domain restriction.
    if (normalized.kind === RuleKind.Cosmetic && !isDomainRestricted) {
        score += 3;
        reasons.push('generic cosmetic selector (no domain restriction)');
        blastRadiusFlags.push('genericSelector');
    }

    // 2. Bare network block without a trusted effective domain restriction.
    if (normalized.kind === RuleKind.Network && !isException && !isDomainRestricted) {
        score += 3;
        reasons.push('network rule has no trusted effective domain restriction');
        blastRadiusFlags.push('thirdPartyDomainRule');
    }

    // 3. Broad attribute/contains selector.
    if (typeof normalized.selector === 'string' && normalized.selector.includes('*=')) {
        score += 1;
        reasons.push('broad attribute-match selector');
        blastRadiusFlags.push('broadSelector');
    }

    // 4. Scriptlet usage.
    if (normalized.kind === RuleKind.Scriptlet) {
        score += 1;
        reasons.push('uses a scriptlet');
        blastRadiusFlags.push('usesScriptlet');
    }

    // 4 (cont.). Script-blocking modifier.
    if (normalized.modifiers.includes('script')) {
        score += 1;
        reasons.push('blocks a script');
        blastRadiusFlags.push('blocksScript');
    }

    // 5. Generic exception rule with no domain restriction.
    if (isException && !isDomainRestricted) {
        score += 3;
        reasons.push('generic exception rule');
        blastRadiusFlags.push('exceptionRule');
    }

    // 6. Touches a sensitive area.
    const lower = rule.toLowerCase();
    if (SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw))) {
        score += 3;
        reasons.push('rule touches a sensitive area (auth/payment/player)');
        blastRadiusFlags.push('touchesSensitiveArea');
    }

    // Baseline: a domain-restricted rule is scoped and gets a floor of 1.
    if (isDomainRestricted) {
        score += 1;
        reasons.push('domain-restricted');
        blastRadiusFlags.push('domainRestricted');
    }

    // Clamp to the valid range.
    if (score > 5) {
        score = 5;
    }
    if (score < 0) {
        score = 0;
    }

    // An unclassifiable rule defaults to the lowest non-zero risk.
    if (score === 0) {
        score = 1;
        reasons.push('unable to classify; default low');
    }

    // Surface caller-supplied blast-radius hints as informational flags.
    if (options?.affectsMultipleKnownSites === true) {
        reasons.push('may affect multiple known sites');
        blastRadiusFlags.push('affectsMultipleKnownSites');
    }
    if (options?.removesLargeDomSubtree === true) {
        reasons.push('may remove a large DOM subtree');
        blastRadiusFlags.push('removesLargeDomSubtree');
    }

    const level = levelForScore(score);
    return {
        score,
        level,
        reasons,
        blastRadiusFlags,
        requiredAction: actionForLevel(level),
    };
}

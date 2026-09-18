import { PlacementRuleType } from '../types/placement-rule-type';
import { RuleKind, normalizeRule, type NormalizedRule } from './rule-normalizer';

/**
 * The one authority on which placement kind a candidate rule is.
 *
 * Three consumers ask the same question and must get the same answer: the terminal prerequisites
 * that make the model resolve placement for the exact candidate it submits, the run instruction's
 * per-kind `placement:` declaration, and the resolver input the placement tool builds. A second
 * spelling of this mapping would let a rule be a scriptlet for one of them and cosmetic for
 * another, and the declaration for a kind would then silently miss the candidate it was written
 * for.
 */

/**
 * Infer the resolver's concrete placement type from trusted candidate syntax.
 *
 * @param candidate - Deterministically normalized candidate rule.
 * @returns Placement rule type, or undefined for non-actionable syntax.
 */
export function placementRuleTypeForCandidate(
    candidate: NormalizedRule,
): PlacementRuleType | undefined {
    if (candidate.isException) {
        return PlacementRuleType.Exception;
    }
    if (candidate.kind === RuleKind.Scriptlet) {
        return PlacementRuleType.Scriptlet;
    }
    if (candidate.kind === RuleKind.Network) {
        return PlacementRuleType.Network;
    }
    if (candidate.kind === RuleKind.Cosmetic) {
        return PlacementRuleType.Cosmetic;
    }
    return undefined;
}

/**
 * Infer the placement type of one raw candidate rule line.
 *
 * @param rule - Exact candidate rule text.
 * @returns Placement rule type, or undefined for non-actionable syntax.
 */
export function placementRuleTypeOfRule(rule: string): PlacementRuleType | undefined {
    return placementRuleTypeForCandidate(normalizeRule(rule));
}

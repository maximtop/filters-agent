import {
    DOMAIN_EVIDENCE_CONFIDENCE,
    NO_PLACEMENT_EVIDENCE_REASON,
    SIMILAR_RULE_EVIDENCE_CONFIDENCE,
    domainEvidenceTarget,
    shapeCensusTarget,
    type EvidenceTarget,
} from './placement-evidence';
import {
    ADGUARD_BASE_FILTER,
    MAX_ALTERNATIVES,
    distinctFilterNames,
    similarRuleFile,
} from './placement-map-index';
import type { PlacementInput, PlacementResolution } from './placement-resolver';
import { PlacementRuleType } from '../types/placement-rule-type';
import type { PlacementMap } from '../types/repo-context';

/**
 * Placement for a repository the AdguardFilters routing does not describe.
 *
 * The language-and-section routing is one repository's layout. On any other checkout it could only
 * reach its own fallbacks, and on a real EasyList clone that meant `cleaned-domains.txt` — 1064
 * bare dead domains at the repository root — proposed at confidence 0.4 for a site-specific hiding
 * rule. This module answers the same question from what the checkout holds instead, and answers
 * nothing when the checkout holds nothing to go on.
 */

/**
 * Name one resolved file the way the checkout names it.
 *
 * @param map - Generated placement map for the checkout.
 * @param filePath - Checkout-relative file the resolution settled on.
 * @returns The list name the map gives that file, falling back to the path itself.
 */
function filterNameForPath(map: PlacementMap, filePath: string): string {
    return map.files.find((file) => file.relativePath === filePath)?.filter ?? filePath;
}

/**
 * Turn one evidence hit into the resolution the caller answers with.
 *
 * @param map - Generated placement map for the checkout.
 * @param target - The file the evidence names, with its confidence and reason.
 * @param reasons - Reasons accumulated before this hit.
 * @param alternatives - Other list names of the repository.
 * @returns The resolved placement.
 */
function evidenceResolution(
    map: PlacementMap,
    target: EvidenceTarget,
    reasons: readonly string[],
    alternatives: readonly string[],
): PlacementResolution {
    const filter = filterNameForPath(map, target.filePath);
    return {
        filter,
        filePath: target.filePath,
        confidence: target.confidence,
        alternatives: alternatives.filter((name) => name !== filter).slice(0, MAX_ALTERNATIVES),
        reasons: [...reasons, target.reason],
    };
}

/**
 * Resolve placement from what the checkout itself holds, for a repository this routing does not
 * know.
 *
 * The order is the order a maintainer reads a repository in: the file holding the rule an exception
 * has to cancel, then where this site's rules already are, then where the rules this one resembles
 * are, then where rules of this shape are kept. Nothing left means no answer — a repository that
 * holds no rule like this one has not been told where to put it, and naming the map's first file
 * instead is how a cosmetic rule was proposed for a list of bare dead domains.
 *
 * @param input - The site and rule context for the candidate rule, carrying the collected evidence.
 * @param map - The generated placement map for the checkout.
 * @returns The resolved placement, or an empty target carrying the reason there is none.
 */
export function resolveFromCheckoutEvidence(
    input: PlacementInput,
    map: PlacementMap,
): PlacementResolution {
    const reasons: string[] = [
        `this repository has no '${ADGUARD_BASE_FILTER}', so the AdGuard language and section ` +
            "routing does not describe it; the checkout's own rules decide instead",
    ];
    const alternatives = distinctFilterNames(map);
    const { candidateRule, evidence } = input;
    const similar = similarRuleFile(input.existingSimilarRules, map);
    // An exception neutralises a rule that lives in one specific file, and humans file it beside
    // that rule's established family there — the reported site has nothing to do with it. This is
    // the same first signal the AdGuard routing uses, ahead of everything the census can say.
    if (input.ruleType === PlacementRuleType.Exception && similar !== undefined) {
        return evidenceResolution(
            map,
            {
                filePath: similar.relativePath,
                confidence: DOMAIN_EVIDENCE_CONFIDENCE,
                reason:
                    `exception joins its established family in '${similar.relativePath}' ` +
                    '(culprit file)',
            },
            reasons,
            alternatives,
        );
    }
    if (candidateRule !== undefined && evidence !== undefined) {
        const byDomain = domainEvidenceTarget(candidateRule, evidence);
        if (byDomain !== undefined) {
            return evidenceResolution(map, byDomain, reasons, alternatives);
        }
    }
    if (similar !== undefined) {
        return evidenceResolution(
            map,
            {
                filePath: similar.relativePath,
                confidence: SIMILAR_RULE_EVIDENCE_CONFIDENCE,
                reason:
                    `the similar rules found for this candidate all live in ` +
                    `'${similar.relativePath}'`,
            },
            reasons,
            alternatives,
        );
    }
    if (candidateRule !== undefined && evidence !== undefined) {
        const byShape = shapeCensusTarget(candidateRule, evidence);
        if (byShape !== undefined) {
            return evidenceResolution(map, byShape, reasons, alternatives);
        }
    }
    reasons.push(NO_PLACEMENT_EVIDENCE_REASON);
    return {
        filter: '',
        filePath: '',
        confidence: 0,
        alternatives: alternatives.slice(0, MAX_ALTERNATIVES),
        reasons,
    };
}

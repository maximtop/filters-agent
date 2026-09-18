import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { domainScopeCovers } from './domain-scope';
import { filterFileLines } from './filter-file-lines';
import { samePlacementFamily } from './rule-family';
import { normalizeRule, RuleKind, type NormalizedRule } from './rule-normalizer';

/**
 * What a checkout already says about where a rule of this shape goes.
 *
 * The deterministic router knows one repository's layout — AdguardFilters' language filters and
 * named sections — and on any other repository it had nothing to answer with. Probed against a real
 * EasyList checkout it sent a site-specific hiding rule to `cleaned-domains.txt`, a root file of
 * bare dead domains, at confidence 0.4, because `BaseFilter` was absent from the map and the
 * fallback took the map's first file. A repository nobody configured has to be read instead of
 * guessed at: the site's own rules, then rules like this one, then rules of this shape.
 *
 * The scan lives here rather than in the resolver because the resolver is pure — it sees only the
 * placement map — and a file census is a fact about the checkout. The caller collects the evidence
 * once per run and hands it in.
 */

/**
 * The shapes a candidate rule can have, as the census counts them.
 *
 * Two rules of the same shape are filed together by maintainers even when they do entirely
 * different things: a repository that keeps site-scoped hiding rules apart from generic ones, or
 * ad-server host blocks apart from site-scoped request blocks, is stating that shape decides the
 * file.
 */
export const RuleShape = {
    /**
     * A cosmetic rule scoped to one or more domains.
     */
    DomainScopedCosmetic: 'domain_scoped_cosmetic',

    /**
     * A cosmetic rule with no domain scope, applying everywhere.
     */
    GenericCosmetic: 'generic_cosmetic',

    /**
     * A network rule narrowed by a `$domain=` scope.
     */
    DomainScopedNetwork: 'domain_scoped_network',

    /**
     * An unscoped network block, the ad-server host-block shape.
     */
    UnscopedBlock: 'unscoped_block',

    /**
     * An exception rule, network or cosmetic.
     */
    Exception: 'exception',

    /**
     * A scriptlet injection rule.
     */
    Scriptlet: 'scriptlet',
} as const;

/**
 * Every rule shape value, for schemas and exhaustive listings.
 */
export const RULE_SHAPE_VALUES = Object.values(RuleShape);

/**
 * Shape of one rule, as the census counts it.
 */
export type RuleShape = (typeof RuleShape)[keyof typeof RuleShape];

/**
 * Plain-language name of each shape, for the reason a resolution states.
 */
const RULE_SHAPE_LABELS: Readonly<Record<RuleShape, string>> = {
    [RuleShape.DomainScopedCosmetic]: 'site-scoped cosmetic',
    [RuleShape.GenericCosmetic]: 'generic cosmetic',
    [RuleShape.DomainScopedNetwork]: 'site-scoped network',
    [RuleShape.UnscopedBlock]: 'unscoped network block',
    [RuleShape.Exception]: 'exception',
    [RuleShape.Scriptlet]: 'scriptlet',
};

/**
 * Largest list file the census reads.
 *
 * A file above this size cannot be bound as a candidate target at all — the review checkout refuses
 * a preimage over the same ceiling — so counting its rules could only produce a placement no edit
 * could ever be locked against.
 */
export const MAX_CENSUS_FILE_BYTES = 16 * 1024 * 1024;

/**
 * A raw network pattern that is nothing but a hostname.
 *
 * A file of bare dead domains parses as a list of unscoped network blocks, and EasyList ships
 * exactly one — `cleaned-domains.txt`, 1064 lines of them at the repository root. Counting those as
 * ad-server blocks is what let the resolver answer with that file, so a pattern carrying no filter
 * syntax at all is not counted as a rule of any shape.
 */
const BARE_HOSTNAME_PATTERN =
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu;

/**
 * Per-file count of rules already scoped to the reported domain.
 */
export const DomainFamilyEvidenceSchema = v.object({
    filePath: v.pipe(v.string(), v.minLength(1)),
    cosmeticRules: v.pipe(v.number(), v.integer(), v.minValue(0)),
    networkRules: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type DomainFamilyEvidence = v.InferOutput<typeof DomainFamilyEvidenceSchema>;

/**
 * Per-file count of rules of one shape.
 */
export const ShapeEvidenceSchema = v.object({
    filePath: v.pipe(v.string(), v.minLength(1)),
    shape: v.picklist(RULE_SHAPE_VALUES),
    rules: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type ShapeEvidence = v.InferOutput<typeof ShapeEvidenceSchema>;

/**
 * What one checkout says about where the run's candidates belong.
 */
export const PlacementEvidenceSchema = v.object({
    domainFamilyFiles: v.array(DomainFamilyEvidenceSchema),
    shapeFiles: v.array(ShapeEvidenceSchema),
});
export type PlacementEvidence = v.InferOutput<typeof PlacementEvidenceSchema>;

/**
 * One file the evidence names, with the confidence and reason that naming carries.
 */
export interface EvidenceTarget {
    /**
     * Checkout-relative list file the evidence points at.
     */
    filePath: string;

    /**
     * Confidence the resolution answers with.
     */
    confidence: number;

    /**
     * Why this file, in the words the resolution states.
     */
    reason: string;
}

/**
 * Confidence a file already holding the reported site's own rules answers with.
 *
 * It is the strongest signal short of the repository saying so itself: the site's rules are in this
 * file because a maintainer put them there. It stays below the 0.9 of an exact AdGuard section hit
 * only because that routing is the repository's documented layout rather than an inference.
 */
export const DOMAIN_EVIDENCE_CONFIDENCE = 0.8;

/**
 * Fewest rules a file must already hold for the reported site before it counts as that site's home.
 *
 * One rule says the site appears in a list, not that its rules live there. Probed against the real
 * EasyList clone, `sitepoint.com` has exactly one rule in the whole repository — a newsletter-popup
 * rule in `fanboy-addon/fanboy_newsletter_specific_hide.txt` — and a single-rule threshold sent an
 * ad-hiding candidate into the newsletter add-on list. Filing an ad rule into an annoyance list on
 * the strength of one unrelated line is the exact failure the instruction's declaration was added
 * for; two rules is the least that distinguishes a home from a coincidence.
 */
export const MIN_DOMAIN_EVIDENCE_RULES = 2;

/**
 * Confidence a file named by the run's own similar-rule hints answers with.
 *
 * The hints are checkout-validated repository lines, but they were surfaced by a search the model
 * chose the terms for, so they say less than the reported site's own rules do.
 */
export const SIMILAR_RULE_EVIDENCE_CONFIDENCE = 0.7;

/**
 * Confidence the shape census answers with.
 *
 * A census says where rules like this one are kept, which is a real fact about the repository and a
 * much better answer than a language route the repository does not use — but it is a population
 * count, not a statement about this site, so it stays well below both signals above.
 */
export const SHAPE_CENSUS_CONFIDENCE = 0.6;

/**
 * The reason a resolution gives when the checkout says nothing about where the rule goes.
 */
export const NO_PLACEMENT_EVIDENCE_REASON =
    'no list file in this checkout holds rules of this shape and nothing names a target, so no ' +
    'placement is proposed rather than inventing one';

/**
 * Classify one repository rule into the shape the census counts.
 *
 * @param normalized - Deterministically normalized repository rule.
 * @returns The rule's shape, or undefined when the line is not a rule of any counted shape.
 */
function ruleShapeOf(normalized: NormalizedRule): RuleShape | undefined {
    if (normalized.kind === RuleKind.Comment || normalized.kind === RuleKind.Empty) {
        return undefined;
    }
    if (normalized.isException) {
        return RuleShape.Exception;
    }
    if (normalized.kind === RuleKind.Scriptlet) {
        return RuleShape.Scriptlet;
    }
    if (normalized.kind === RuleKind.Cosmetic) {
        return normalized.domains.length > 0
            ? RuleShape.DomainScopedCosmetic
            : RuleShape.GenericCosmetic;
    }
    if (normalized.kind !== RuleKind.Network || normalized.urlPattern === undefined) {
        return undefined;
    }
    if (normalized.modifiers.length === 0 && BARE_HOSTNAME_PATTERN.test(normalized.urlPattern)) {
        return undefined;
    }
    return normalized.domains.length > 0 ? RuleShape.DomainScopedNetwork : RuleShape.UnscopedBlock;
}

/**
 * Classify one raw candidate rule into the shape the census counts.
 *
 * @param rule - Exact candidate rule text.
 * @returns The candidate's shape, or undefined when its syntax is not actionable.
 */
export function ruleShapeOfRule(rule: string): RuleShape | undefined {
    return ruleShapeOf(normalizeRule(rule));
}

/**
 * Whether one repository rule's positive scopes reach the reported hostname.
 *
 * @param normalized - Deterministically normalized repository rule.
 * @param reportedDomain - Reported hostname the run is fixing.
 * @returns Whether the rule already applies to that hostname by an explicit scope.
 */
function scopesReportedDomain(normalized: NormalizedRule, reportedDomain: string): boolean {
    return normalized.domains.some(
        (domain) => !domain.startsWith('~') && domainScopeCovers(domain, reportedDomain),
    );
}

/**
 * Read one checkout's list files and count what they already hold.
 *
 * @param checkoutPath - Root of the pinned filters checkout.
 * @param listPaths - Checkout-relative list files a placement may name.
 * @param reportedDomain - Reported hostname the run is fixing.
 * @returns The per-file counts every evidence branch reads.
 */
export function collectPlacementEvidence(
    checkoutPath: string,
    listPaths: Iterable<string>,
    reportedDomain: string,
): PlacementEvidence {
    const domainFamilyFiles: DomainFamilyEvidence[] = [];
    const shapeFiles: ShapeEvidence[] = [];
    for (const filePath of [...listPaths].sort()) {
        let content: string;
        try {
            if (statSync(join(checkoutPath, filePath)).size > MAX_CENSUS_FILE_BYTES) {
                continue;
            }
            content = readFileSync(join(checkoutPath, filePath), 'utf8');
        } catch {
            // A map entry the checkout no longer holds contributes no evidence; the file that is
            // there decides placement, and a vanished one is not a target either way.
            continue;
        }
        const shapeCounts = new Map<RuleShape, number>();
        let cosmeticRules = 0;
        let networkRules = 0;
        for (const line of filterFileLines(content)) {
            const normalized = normalizeRule(line);
            const shape = ruleShapeOf(normalized);
            if (shape === undefined) {
                continue;
            }
            shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
            if (!scopesReportedDomain(normalized, reportedDomain)) {
                continue;
            }
            if (samePlacementFamily(RuleKind.Network, normalized.kind)) {
                networkRules += 1;
            } else {
                cosmeticRules += 1;
            }
        }
        if (cosmeticRules > 0 || networkRules > 0) {
            domainFamilyFiles.push({ filePath, cosmeticRules, networkRules });
        }
        for (const [shape, rules] of shapeCounts) {
            shapeFiles.push({ filePath, shape, rules });
        }
    }
    return { domainFamilyFiles, shapeFiles };
}

/**
 * Build a collector that reads one checkout at most once per reported domain.
 *
 * Every candidate of a run asks about the same checkout and the same reported site, so the scan's
 * answer is the same one every time; re-reading a 26 MB corpus per `resolve_placement` call would
 * pay for that answer again on every candidate.
 *
 * @param checkoutPath - Root of the pinned filters checkout.
 * @param listPaths - Checkout-relative list files a placement may name.
 * @returns A memoized collector keyed by reported domain.
 */
export function createPlacementEvidenceCollector(
    checkoutPath: string,
    listPaths: Iterable<string>,
): (reportedDomain: string) => PlacementEvidence {
    const paths = [...listPaths];
    const collected = new Map<string, PlacementEvidence>();
    return (reportedDomain) => {
        const cached = collected.get(reportedDomain);
        if (cached !== undefined) {
            return cached;
        }
        const evidence = collectPlacementEvidence(checkoutPath, paths, reportedDomain);
        collected.set(reportedDomain, evidence);
        return evidence;
    };
}

/**
 * Pick the single file that already holds the reported site's rules of the candidate's family.
 *
 * Several files holding them is normal — a site can have both an ad rule and a cookie rule — so the
 * one holding the most wins, and a tie is no answer at all: two files with equal claim means the
 * repository has not said which, and a later signal gets to.
 *
 * @param candidateRule - Locked candidate rule.
 * @param evidence - The run's collected evidence.
 * @returns The file the site's own rules point at, or undefined when none does unambiguously.
 */
export function domainEvidenceTarget(
    candidateRule: string,
    evidence: PlacementEvidence,
): EvidenceTarget | undefined {
    const candidateKind = normalizeRule(candidateRule).kind;
    const networkFamily = samePlacementFamily(RuleKind.Network, candidateKind);
    const counted = evidence.domainFamilyFiles
        .map((entry) => ({
            filePath: entry.filePath,
            rules: networkFamily ? entry.networkRules : entry.cosmeticRules,
        }))
        .filter((entry) => entry.rules >= MIN_DOMAIN_EVIDENCE_RULES)
        .sort(
            (left, right) =>
                right.rules - left.rules || left.filePath.localeCompare(right.filePath),
        );
    const best = counted[0];
    if (best === undefined || counted[1]?.rules === best.rules) {
        return undefined;
    }
    return {
        filePath: best.filePath,
        confidence: DOMAIN_EVIDENCE_CONFIDENCE,
        reason:
            `the reported site's own rules of this kind already live in '${best.filePath}' ` +
            `(${best.rules} there)`,
    };
}

/**
 * Pick the file holding the most rules of the candidate's shape.
 *
 * @param candidateRule - Locked candidate rule.
 * @param evidence - The run's collected evidence.
 * @returns The file rules of this shape are kept in, or undefined when the checkout holds none.
 */
export function shapeCensusTarget(
    candidateRule: string,
    evidence: PlacementEvidence,
): EvidenceTarget | undefined {
    const shape = ruleShapeOfRule(candidateRule);
    if (shape === undefined) {
        return undefined;
    }
    const counted = evidence.shapeFiles
        .filter((entry) => entry.shape === shape && entry.rules > 0)
        // Ties are broken by path so the same checkout always answers the same way; unlike domain
        // evidence there is nothing better to fall through to, and refusing to place a rule because
        // two files hold equally many of its shape would help nobody.
        .sort(
            (left, right) =>
                right.rules - left.rules || left.filePath.localeCompare(right.filePath),
        );
    const best = counted[0];
    if (best === undefined) {
        return undefined;
    }
    const runnerUp = counted[1];
    return {
        filePath: best.filePath,
        confidence: SHAPE_CENSUS_CONFIDENCE,
        reason:
            `'${best.filePath}' holds the most ${RULE_SHAPE_LABELS[shape]} rules in this ` +
            `repository (${best.rules})` +
            (runnerUp === undefined ? '' : `, ahead of '${runnerUp.filePath}' (${runnerUp.rules})`),
    };
}

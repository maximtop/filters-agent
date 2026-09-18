import * as v from 'valibot';
import {
    DECLARED_PLACEMENT_CONFIDENCE,
    DECLARED_PLACEMENT_REASON,
    declaredPlacementAbsentReason,
    type DeclaredPlacementTarget,
} from './declared-placement';
import { PlacementEvidenceSchema } from './placement-evidence';
import { resolveFromCheckoutEvidence } from './placement-evidence-routing';
import {
    ADGUARD_BASE_FILTER,
    MAX_ALTERNATIVES,
    distinctFilterNames,
    familyDirectory,
    filterInMap,
    findRegionalSection,
    findSection,
    findSectionInDirectory,
    firstFilePath,
    firstFilterName,
    indexPlacementMap,
    normalizeKey,
    similarRuleFile,
} from './placement-map-index';
import { PlacementRuleType, PlacementRuleTypeSchema } from '../types/placement-rule-type';
import type { PlacementMap } from '../types/repo-context';

/**
 * The inputs needed to deterministically resolve where a candidate rule belongs.
 *
 * Mirrors the `resolve_placement` contract in REQUIREMENTS.md §4.6.
 */
export const PlacementInputSchema = v.object({
    siteLanguage: v.pipe(v.string(), v.minLength(1)),
    siteRegion: v.pipe(v.string(), v.minLength(1)),
    ruleType: PlacementRuleTypeSchema,
    requestDomain: v.optional(v.pipe(v.string(), v.minLength(1))),
    targetDomain: v.pipe(v.string(), v.minLength(1)),
    issueLabels: v.array(v.string()),
    product: v.optional(v.string()),
    cyrillicBoth: v.optional(v.boolean()),
    existingSimilarRules: v.array(v.object({ rule: v.string(), filePath: v.string() })),
    candidateRule: v.optional(v.pipe(v.string(), v.minLength(1))),
    evidence: v.optional(PlacementEvidenceSchema),
});
export type PlacementInput = v.InferOutput<typeof PlacementInputSchema>;

/**
 * The resolved placement decision: target filter file and explanatory metadata. The in-file
 * position deliberately does not appear here - this resolver only reads the placement map, so a
 * positional claim would be fabricated; the checkout-backed `planRepositoryEdit` owns that.
 *
 * This is a superset of `PlacementResultSchema` (it additionally carries `reasons`).
 */
export const PlacementResolutionSchema = v.object({
    filter: v.string(),
    filePath: v.string(),
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    alternatives: v.array(v.string()),
    reasons: v.array(v.string()),
});
export type PlacementResolution = v.InferOutput<typeof PlacementResolutionSchema>;

/**
 * The CLI payload for `repo placement`: a path to a placement-map.json plus the resolver input.
 *
 * The command prints one `PlacementResolutionSchema` JSON object. Breaking shape change 2026-08-31:
 * `insertionPoint` was removed from that output - the resolver never knew a real file position;
 * consumers needing one use the checkout-backed plan from `resolve_placement`.
 */
export const PlacementCliInputSchema = v.object({
    mapPath: v.pipe(v.string(), v.minLength(1)),
    input: PlacementInputSchema,
});
export type PlacementCliInput = v.InferOutput<typeof PlacementCliInputSchema>;

/**
 * Known regional filters keyed by ISO 639-1 language code (lowercase). Used to match a site
 * language to a dedicated regional filter per REQUIREMENTS.md §2.5.
 */
const REGIONAL_FILTERS: Readonly<Record<string, string>> = {
    de: 'GermanFilter',
    fr: 'FrenchFilter',
    es: 'Spanish/PortugueseFilter',
    pt: 'Spanish/PortugueseFilter',
    it: 'ItalianFilter',
    nl: 'DutchFilter',
    pl: 'PolishFilter',
    tr: 'TurkishFilter',
    zh: 'ChineseFilter',
    ja: 'JapaneseFilter',
    ko: 'KoreanFilter',
    ar: 'ArabicFilter',
    he: 'HebrewFilter',
    id: 'IndonesianFilter',
};

/**
 * Extract the lowercase primary language subtag used for regional filter routing.
 *
 * @param languageTag - Language code or BCP-47 language tag supplied by issue analysis.
 * @returns Lowercase primary language subtag, such as `zh` for `zh-TW`.
 */
function primaryLanguageSubtag(languageTag: string): string {
    return languageTag.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * Test whether issue metadata explicitly classifies the report as an anti-adblock script.
 *
 * @param labels - Issue labels supplied to the placement resolver.
 * @returns Whether the canonical anti-adblock label is present.
 */
function hasAntiAdblockLabel(labels: readonly string[]): boolean {
    return labels.some((label) => normalizeKey(label) === 'tantiadblockscript');
}

/**
 * Determine whether a candidate is a Russian anti-adblock network rule.
 *
 * @param input - Candidate placement context.
 * @returns Whether the dedicated Russian anti-adblock route applies.
 */
function isRussianAntiAdblock(input: PlacementInput): boolean {
    if (
        primaryLanguageSubtag(input.siteLanguage) !== 'ru' ||
        input.cyrillicBoth === true ||
        input.ruleType !== PlacementRuleType.Network
    ) {
        return false;
    }
    return hasAntiAdblockLabel(input.issueLabels);
}

/**
 * Resolve the target filter file and insertion point for a candidate rule.
 *
 * Pure and deterministic: routing follows REQUIREMENTS.md §2.5 / §4.6. Language selects the filter
 * (Russian anti-adblock → RussianFilter/antiadblock; Cyrillic both ru+uk → CyrillicFilters/common;
 * a language with a dedicated filter → that regional filter; otherwise BaseFilter). When a known
 * regional filter is absent, non-English rules fall back to BaseFilter/foreign. The rule type then
 * selects the section (exception → specific; ad/tracking network block → adservers when available;
 * otherwise specific). Every fallback lowers confidence and is explained in `reasons`.
 *
 * A run whose instruction declares its placement never reaches that routing: the declaration is the
 * answer, at full confidence and with no alternative, because the repository has already said where
 * its rules go. The routing below is the AdGuard repository's own shape — language, then section —
 * and applying it to a repository that declares something else is what filed an ad-network rule
 * into a cookie-annoyance list in run 34996815226.
 *
 * A repository whose map holds no `BaseFilter` is not that shape at all, and the routing could only
 * reach its own fallbacks there. Such a checkout is read instead of routed ({@link
 * resolveFromCheckoutEvidence}), which applies the same signals in the same order under reasons
 * that are true of it. The gate is the map's shape rather than the branch order so that an
 * AdguardFilters run keeps exactly the routing it has: a same-family domain census would happily
 * file an ad rule into the cookie-annoyance list a site already has a rule in, which is the failure
 * the declaration was added for.
 *
 * @param input - The site and rule context for the candidate rule.
 * @param map - The generated placement map for the checkout.
 * @param declared - The run instruction's declared placement bound to the checkout, when the
 *   instruction declares one for this candidate's kind; it decides the answer on its own.
 * @returns The resolved placement decision with confidence, alternatives, and reasons.
 */
export function resolvePlacement(
    input: PlacementInput,
    map: PlacementMap,
    declared?: DeclaredPlacementTarget,
): PlacementResolution {
    if (declared !== undefined) {
        return {
            filter: declared.title ?? declared.filePath,
            filePath: declared.filePath,
            confidence: DECLARED_PLACEMENT_CONFIDENCE,
            alternatives: [],
            reasons: declared.absentFromCheckout
                ? [DECLARED_PLACEMENT_REASON, declaredPlacementAbsentReason(declared.filePath)]
                : [DECLARED_PLACEMENT_REASON],
        };
    }
    const index = indexPlacementMap(map);
    if (!filterInMap(index, ADGUARD_BASE_FILTER)) {
        return resolveFromCheckoutEvidence(input, map);
    }
    const reasons: string[] = [];
    const lang = primaryLanguageSubtag(input.siteLanguage);
    const russianAntiAdblock = isRussianAntiAdblock(input);

    // 1. Preferred filter by language (§2.5), first match wins.
    let preferredFilter: string;
    let cyrillicCommon = false;
    const exceptionFamilyFile =
        input.ruleType === PlacementRuleType.Exception
            ? similarRuleFile(input.existingSimilarRules, map)
            : undefined;
    if (exceptionFamilyFile !== undefined) {
        // An exception neutralises a rule that lives in one specific file, and humans file it
        // beside its established family there — the reported site's language is irrelevant.
        preferredFilter = exceptionFamilyFile.filter;
        reasons.push(
            `exception joins its established family in '${exceptionFamilyFile.relativePath}' ` +
                '(culprit file)',
        );
    } else if (russianAntiAdblock) {
        preferredFilter = 'CyrillicFilters';
        reasons.push('Russian anti-adblock rule → CyrillicFilters/RussianFilter/antiadblock');
    } else if (input.cyrillicBoth === true && (lang === 'ru' || lang === 'uk')) {
        preferredFilter = 'CyrillicFilters';
        cyrillicCommon = true;
        reasons.push('cyrillic traffic both ru and uk → CyrillicFilters/common');
    } else {
        const regional = REGIONAL_FILTERS[lang];
        if (regional !== undefined) {
            preferredFilter = regional;
            reasons.push(`language '${lang}' has a dedicated regional filter`);
        } else {
            preferredFilter = ADGUARD_BASE_FILTER;
            reasons.push('no dedicated regional filter → BaseFilter (international/misc)');
        }
    }

    // Resolve the actually-present filter, falling back when the preferred one is absent.
    let chosenFilter: string;
    let filterAbsent = false;
    if (filterInMap(index, preferredFilter)) {
        chosenFilter = preferredFilter;
    } else {
        filterAbsent = true;
        chosenFilter = filterInMap(index, ADGUARD_BASE_FILTER)
            ? ADGUARD_BASE_FILTER
            : (firstFilterName(index) ?? ADGUARD_BASE_FILTER);
        reasons.push(
            `filter '${preferredFilter}' absent from placement map → fell back to '${chosenFilter}'`,
        );
    }
    const chosenSections = index[chosenFilter];

    // 2. Section routing within the chosen filter.
    let section: string;
    if (input.ruleType === PlacementRuleType.Exception) {
        // Humans land incorrect-blocking exceptions in the causing filter's allowlist section;
        // filters without one keep the historical 'specific' fallback.
        if (findSection(chosenSections, 'allowlist', 'allowlist.txt') !== undefined) {
            section = 'allowlist';
            reasons.push("exception rules go to the 'allowlist' section");
        } else {
            section = 'specific';
            reasons.push("no allowlist section → exception falls back to 'specific'");
        }
    } else if (russianAntiAdblock) {
        section = 'antiadblock';
    } else if (cyrillicCommon) {
        section = 'common';
    } else if (
        input.ruleType === PlacementRuleType.Network &&
        input.requestDomain !== undefined &&
        findSection(chosenSections, 'adservers', 'adservers.txt') !== undefined
    ) {
        section = 'adservers';
        reasons.push('ad/tracking domain block → adservers section');
    } else {
        section = 'specific';
        reasons.push("no specialized section → 'specific'");
    }

    // 3. File-path lookup with fallbacks.
    let filePath: string | undefined;
    let confidence: number;
    if (filterAbsent) {
        const foreignFallback =
            preferredFilter !== ADGUARD_BASE_FILTER && chosenFilter === ADGUARD_BASE_FILTER
                ? findSection(chosenSections, 'foreign', 'foreign.txt')
                : undefined;
        filePath =
            foreignFallback ??
            findSection(chosenSections, 'specific', 'specific.txt') ??
            firstFilePath(chosenSections);
        confidence = 0.4;
        if (foreignFallback !== undefined) {
            reasons.push("non-English regional fallback → 'foreign'");
        }
    } else {
        const regionalDirect = russianAntiAdblock
            ? findRegionalSection(
                  map,
                  chosenFilter,
                  'RussianFilter',
                  section,
                  input.existingSimilarRules,
              )
            : undefined;
        // The family fixes the directory, not the file: one filter ships several independently
        // distributed sub-filters, so the exception must stay inside the family's own — while
        // the section still decides which file there, because humans file exceptions in the
        // allowlist even when the family they follow sits in another section.
        const familyDirect =
            exceptionFamilyFile !== undefined && exceptionFamilyFile.filter === chosenFilter
                ? findSectionInDirectory(
                      map,
                      chosenFilter,
                      familyDirectory(exceptionFamilyFile.relativePath),
                      section,
                  )
                : undefined;
        const direct =
            familyDirect ??
            regionalDirect ??
            findSection(chosenSections, section, `${section}.txt`);
        if (direct !== undefined) {
            filePath = direct;
            confidence = 0.9;
        } else {
            const regionalSpecific = russianAntiAdblock
                ? findRegionalSection(
                      map,
                      chosenFilter,
                      'RussianFilter',
                      'specific',
                      input.existingSimilarRules,
                  )
                : undefined;
            filePath =
                regionalSpecific ??
                findSection(chosenSections, 'specific', 'specific.txt') ??
                firstFilePath(chosenSections);
            confidence = 0.6;
            reasons.push(
                `section '${section}' not found in '${chosenFilter}' → fell back to 'specific'`,
            );
        }
    }

    // 4. Clamp confidence into [0, 1].
    confidence = Math.min(1, Math.max(0, confidence));

    // 5. Alternative filters (the other top-level filters in the map).
    const alternatives = distinctFilterNames(map)
        .filter((name) => name !== chosenFilter)
        .slice(0, MAX_ALTERNATIVES);

    return {
        filter: chosenFilter,
        filePath: filePath ?? '',
        confidence,
        alternatives,
        reasons,
    };
}

import * as v from 'valibot';
import type { FilterFileEntry, PlacementMap } from '../types/repo-context';

/**
 * The candidate rule's structural type, used to route it to the right filter section.
 */
export const PlacementRuleType = {
    Network: 'network',
    Cosmetic: 'cosmetic',
    Exception: 'exception',
    Scriptlet: 'scriptlet',
} as const;

/**
 * Every placement rule type value, for schemas and exhaustive listings.
 */
export const PLACEMENT_RULE_TYPE_VALUES = Object.values(PlacementRuleType);

/**
 * Structural type of one candidate as routed by the placement resolver.
 */
export type PlacementRuleType = (typeof PlacementRuleType)[keyof typeof PlacementRuleType];

export const PlacementRuleTypeSchema = v.picklist(PLACEMENT_RULE_TYPE_VALUES);

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
 * Upper bound on the number of alternative filters surfaced in a resolution.
 */
const MAX_ALTERNATIVES = 5;

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
 * Normalize a section or filter name into a stable comparison key.
 *
 * Lower-cases the value and strips every non-alphanumeric character so that `adservers`, `Ad
 * servers`, and `adservers.txt` compare equal.
 *
 * @param value - The raw name to normalize.
 * @returns The lowercase alphanumeric key.
 */
function normalizeKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Derive the file basename (without extension) from a checkout-relative path.
 *
 * @param relPath - A path relative to the checkout root (forward or back slashes).
 * @returns The final path segment with a trailing `.txt` removed.
 */
function basename(relPath: string): string {
    const parts = relPath.split(/[\\/]/);
    const last = parts[parts.length - 1] ?? relPath;
    return last.replace(/\.txt$/i, '');
}

/**
 * Build a filter → section → relative-path lookup index from a placement map.
 *
 * Each detected section name and each file basename is normalized into a section key so lookups are
 * spelling-agnostic. The first file to claim a key wins, keeping the index deterministic.
 *
 * @param map - The generated placement map.
 * @returns A nested record of filter name to section key to relative file path.
 */
function indexPlacementMap(map: PlacementMap): Record<string, Record<string, string>> {
    const index: Record<string, Record<string, string>> = {};
    for (const file of map.files) {
        const sections: Record<string, string> = index[file.filter] ?? {};
        index[file.filter] = sections;
        const setIfNew = (rawKey: string): void => {
            const key = normalizeKey(rawKey);
            if (key !== '' && sections[key] === undefined) {
                sections[key] = file.relativePath;
            }
        };
        for (const section of file.sections) {
            setIfNew(section.name);
        }
        setIfNew(basename(file.relativePath));
    }
    return index;
}

/**
 * The ordered list of distinct filter names present in a placement map.
 *
 * @param map - The generated placement map.
 * @returns Distinct filter names in first-seen order.
 */
function distinctFilterNames(map: PlacementMap): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const file of map.files) {
        if (!seen.has(file.filter)) {
            seen.add(file.filter);
            names.push(file.filter);
        }
    }
    return names;
}

/**
 * Return the first filter name held in an index, if any.
 *
 * @param index - The filter → sections lookup index.
 * @returns The first filter name, or undefined when the index is empty.
 */
function firstFilterName(index: Record<string, Record<string, string>>): string | undefined {
    const keys = Object.keys(index);
    return keys.length > 0 ? keys[0] : undefined;
}

/**
 * Determine whether a filter name is represented in the index.
 *
 * Matching is spelling-agnostic: an exact normalized match wins, otherwise a containment check in
 * either direction handles compound names; each slash-separated part is also tested so that
 * `Spanish/PortugueseFilter` matches a `SpanishFilter` entry.
 *
 * @param index - The filter → sections lookup index.
 * @param filterName - The candidate filter name to locate.
 * @returns True when the filter (or a closely named sibling) is present.
 */
function filterInMap(index: Record<string, Record<string, string>>, filterName: string): boolean {
    const target = normalizeKey(filterName);
    if (target === '') {
        return false;
    }
    for (const key of Object.keys(index)) {
        const normalized = normalizeKey(key);
        if (normalized === target || normalized.includes(target) || target.includes(normalized)) {
            return true;
        }
    }
    for (const part of filterName.split('/')) {
        const partKey = normalizeKey(part);
        if (partKey === '') {
            continue;
        }
        for (const key of Object.keys(index)) {
            if (normalizeKey(key).includes(partKey)) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Look up a section's file path within a single filter, trying several key spellings.
 *
 * Each preferred key is normalized before lookup so that `adservers` and `adservers.txt` resolve to
 * the same indexed entry when present.
 *
 * @param sections - The section key → relative path record for one filter (or undefined).
 * @param preferredKeys - Ordered section name spellings to try; first hit wins.
 * @returns The relative file path for the first matching section, or undefined.
 */
function findSection(
    sections: Readonly<Record<string, string>> | undefined,
    ...preferredKeys: string[]
): string | undefined {
    if (!sections) {
        return undefined;
    }
    for (const preferred of preferredKeys) {
        const key = normalizeKey(preferred);
        if (key !== '' && sections[key] !== undefined) {
            return sections[key];
        }
    }
    return undefined;
}

/**
 * Return the first stored file path for a filter, if any.
 *
 * Used as a last-resort fallback when no preferred section matches.
 *
 * @param sections - The section key → relative path record for one filter (or undefined).
 * @returns The first relative path, or undefined.
 */
function firstFilePath(sections: Readonly<Record<string, string>> | undefined): string | undefined {
    if (!sections) {
        return undefined;
    }
    const values = Object.values(sections);
    return values.length > 0 ? values[0] : undefined;
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
 * Find a section file inside one nested regional path of a top-level filter.
 *
 * Existing similar-rule paths are considered first only when they resolve to a real allowlisted
 * placement-map entry. This accepts absolute checkout paths (including a temporary `source`
 * directory) while returning the portable checkout-relative path.
 *
 * @param map - Generated placement map for the exact checkout.
 * @param filter - Top-level filter name selected by language routing.
 * @param regionalDirectory - Nested regional directory, such as `RussianFilter`.
 * @param section - Desired section or filename.
 * @param existingSimilarRules - Similar rules and their repository paths.
 * @returns A verified checkout-relative path, or undefined when the section is absent.
 */
function findRegionalSection(
    map: PlacementMap,
    filter: string,
    regionalDirectory: string,
    section: string,
    existingSimilarRules: PlacementInput['existingSimilarRules'],
): string | undefined {
    const sectionKey = normalizeKey(section);
    const regionalSegment = `/${normalizeKey(regionalDirectory)}/`;
    const candidates = map.files.filter((file) => {
        const normalizedPath = `/${file.relativePath.replace(/\\/gu, '/').toLowerCase()}/`;
        const pathKey = normalizedPath
            .split('/')
            .map((segment) => normalizeKey(segment))
            .join('/');
        const sectionMatches =
            normalizeKey(basename(file.relativePath)) === sectionKey ||
            file.sections.some((candidate) => normalizeKey(candidate.name) === sectionKey);
        return file.filter === filter && pathKey.includes(regionalSegment) && sectionMatches;
    });
    if (candidates.length === 0) {
        return undefined;
    }

    for (const similar of existingSimilarRules) {
        const similarPath = similar.filePath.replace(/\\/gu, '/').toLowerCase();
        const matched = candidates.find((candidate) => {
            const relativePath = candidate.relativePath.replace(/\\/gu, '/').toLowerCase();
            return similarPath === relativePath || similarPath.endsWith(`/${relativePath}`);
        });
        if (matched !== undefined) {
            return matched.relativePath;
        }
    }
    return candidates[0]?.relativePath;
}

/**
 * Directory holding one repository file, with its trailing separator.
 *
 * @param relativePath - Checkout-relative file path.
 * @returns The owning lowercase directory prefix, empty for a file at the repository root.
 */
function familyDirectory(relativePath: string): string {
    const normalized = relativePath.replace(/\\/gu, '/');
    const cut = normalized.lastIndexOf('/');
    return cut === -1 ? '' : normalized.slice(0, cut + 1).toLowerCase();
}

/**
 * Find a section file of one filter that lives inside an exact directory.
 *
 * A filter may ship several independently distributed sub-filters, so a same-named section in a
 * sibling directory is the wrong file: it ships apart from the rule the exception must cancel.
 *
 * @param map - Generated placement map for the checkout.
 * @param filter - Top-level filter that owns the file.
 * @param directory - Lowercase directory prefix the file must sit in.
 * @param section - Desired section name.
 * @returns The matching checkout-relative path, or undefined when that directory has no such file.
 */
function findSectionInDirectory(
    map: PlacementMap,
    filter: string,
    directory: string,
    section: string,
): string | undefined {
    if (directory === '') {
        return undefined;
    }
    const sectionKey = normalizeKey(section);
    const match = map.files.find((file) => {
        if (file.filter !== filter) {
            return false;
        }
        const normalizedPath = file.relativePath.replace(/\\/gu, '/').toLowerCase();
        if (!normalizedPath.startsWith(directory)) {
            return false;
        }
        if (normalizedPath.slice(directory.length).includes('/')) {
            return false;
        }
        return (
            normalizeKey(basename(file.relativePath)) === sectionKey ||
            file.sections.some((candidate) => normalizeKey(candidate.name) === sectionKey)
        );
    });
    return match?.relativePath;
}

/**
 * Resolve the single file that already hosts the established family of similar rules.
 *
 * An exception cancels a rule owned by one filter, and maintainers file it beside that family
 * rather than under the reported site's language. Ambiguity is not resolved here: when similar
 * rules straddle several filters, language routing stays in charge.
 *
 * @param existingSimilarRules - Similar rules and their repository paths.
 * @param map - Generated placement map naming the file that owns each path.
 * @returns The single owning file, or undefined when there is no unambiguous one.
 */
function similarRuleFile(
    existingSimilarRules: PlacementInput['existingSimilarRules'],
    map: PlacementMap,
): FilterFileEntry | undefined {
    const owners = new Map<string, FilterFileEntry>();
    for (const similar of existingSimilarRules) {
        const similarPath = similar.filePath.replace(/\\/gu, '/').toLowerCase();
        const owner = map.files.find((file) => {
            const relativePath = file.relativePath.replace(/\\/gu, '/').toLowerCase();
            return similarPath === relativePath || similarPath.endsWith(`/${relativePath}`);
        });
        if (owner !== undefined) {
            owners.set(owner.relativePath, owner);
        }
    }
    if (owners.size === 0) {
        return undefined;
    }
    const files = [...owners.values()];
    // One filter may ship several independently distributed sub-filters, so the owning file is
    // the answer: keeping only its top-level directory would file the exception into a sibling
    // that ships separately from the rule it must cancel.
    return files.every((file) => file.relativePath === files[0]!.relativePath)
        ? files[0]
        : undefined;
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
 * @param input - The site and rule context for the candidate rule.
 * @param map - The generated placement map for the checkout.
 * @returns The resolved placement decision with confidence, alternatives, and reasons.
 */
export function resolvePlacement(input: PlacementInput, map: PlacementMap): PlacementResolution {
    const index = indexPlacementMap(map);
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
            preferredFilter = 'BaseFilter';
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
        chosenFilter = filterInMap(index, 'BaseFilter')
            ? 'BaseFilter'
            : (firstFilterName(index) ?? 'BaseFilter');
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
            preferredFilter !== 'BaseFilter' && chosenFilter === 'BaseFilter'
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

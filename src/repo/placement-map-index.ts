import type { FilterFileEntry, PlacementMap } from '../types/repo-context';

/**
 * Reading one generated placement map: which lists it holds, what each list calls its sections, and
 * which list already owns a family of rules.
 *
 * Split out of `placement-resolver.ts` because two routings now read the same map — the
 * AdguardFilters language-and-section route and the evidence route a repository nobody configured
 * gets — and neither owns these lookups.
 */

/**
 * One existing rule the run's repository search surfaced, as the model echoed it back.
 */
export interface SimilarRuleHint {
    /**
     * The existing rule text.
     */
    rule: string;

    /**
     * Repository path the rule was found in; absolute paths from a temporary source directory are
     * accepted and matched by suffix against the map's checkout-relative entries.
     */
    filePath: string;
}

/**
 * Upper bound on the number of alternative filters surfaced in a resolution.
 */
export const MAX_ALTERNATIVES = 5;

/**
 * The filter every AdguardFilters checkout has, and the one its routing is built around.
 *
 * Its presence is what tells an AdguardFilters-shaped map from any other: the language-and-section
 * routing resolves every non-regional rule against it, and a map without it can only reach that
 * routing's fallbacks — which is how an EasyList checkout was answered with `cleaned-domains.txt`
 * at confidence 0.4.
 */
export const ADGUARD_BASE_FILTER = 'BaseFilter';

/**
 * Normalize a section or filter name into a stable comparison key.
 *
 * Lower-cases the value and strips every non-alphanumeric character so that `adservers`, `Ad
 * servers`, and `adservers.txt` compare equal.
 *
 * @param value - The raw name to normalize.
 * @returns The lowercase alphanumeric key.
 */
export function normalizeKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Derive the file basename (without extension) from a checkout-relative path.
 *
 * @param relPath - A path relative to the checkout root (forward or back slashes).
 * @returns The final path segment with a trailing `.txt` removed.
 */
export function basename(relPath: string): string {
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
export function indexPlacementMap(map: PlacementMap): Record<string, Record<string, string>> {
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
export function distinctFilterNames(map: PlacementMap): string[] {
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
export function firstFilterName(index: Record<string, Record<string, string>>): string | undefined {
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
export function filterInMap(
    index: Record<string, Record<string, string>>,
    filterName: string,
): boolean {
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
export function findSection(
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
export function firstFilePath(
    sections: Readonly<Record<string, string>> | undefined,
): string | undefined {
    if (!sections) {
        return undefined;
    }
    const values = Object.values(sections);
    return values.length > 0 ? values[0] : undefined;
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
export function findRegionalSection(
    map: PlacementMap,
    filter: string,
    regionalDirectory: string,
    section: string,
    existingSimilarRules: readonly SimilarRuleHint[],
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
export function familyDirectory(relativePath: string): string {
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
export function findSectionInDirectory(
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
export function similarRuleFile(
    existingSimilarRules: readonly SimilarRuleHint[],
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

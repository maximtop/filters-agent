/**
 * Reporter filter selection extracted from a desktop AdGuard settings import URL.
 *
 * Desktop products (AdGuard for Windows/Mac) report their configuration with `scheme_version=2` and
 * a dot-separated `filters` parameter, unlike the Browser Extension's `regular_filters` in schemes
 * 3 and 4. The CLI evidence route needs those IDs to reproduce the reporter's filtering instead of
 * browsing with the Base filter alone.
 */

/**
 * Report hosts whose settings import URLs are trusted enough to read filter IDs from.
 */
const TRUSTED_REPORT_HOSTS = new Set(['reports.adguard.com', 'reports.adguard.io']);

/**
 * Largest accepted official filter list identifier.
 */
const MAXIMUM_FILTER_ID = 100_000;

/**
 * Largest number of reporter filters one route reproduces.
 */
const MAXIMUM_REPORTER_FILTERS = 64;

/**
 * Filter identities the reporter had enabled.
 */
export interface ReporterFilterSelection {
    /**
     * Ascending unique official filter list identifiers.
     */
    filterIds: readonly number[];

    /**
     * Settings scheme the identifiers were read from.
     */
    schemeVersion: '2' | '3' | '4';
}

/**
 * Read the reporter's enabled filter IDs from a trusted settings import URL.
 *
 * Malformed, untrusted, or absent input yields null rather than throwing: reproducing the
 * reporter's filters is best-effort evidence fidelity, not a precondition for investigating.
 *
 * @param settingsImportUrl - Optional reporter settings import URL from the parsed issue.
 * @returns Bounded reporter filter selection, or null when none can be trusted.
 */
export function readReporterFilterSelection(
    settingsImportUrl: string | undefined,
): ReporterFilterSelection | null {
    if (!settingsImportUrl) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(settingsImportUrl.replace(/&amp;/giu, '&'));
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || !TRUSTED_REPORT_HOSTS.has(url.hostname.toLowerCase())) {
        return null;
    }
    const schemeValues = url.searchParams.getAll('scheme_version');
    if (schemeValues.length > 1) {
        return null;
    }
    const schemeVersion = schemeValues[0] ?? '2';
    if (schemeVersion !== '2' && schemeVersion !== '3' && schemeVersion !== '4') {
        return null;
    }

    // The parameter, not the scheme number, decides the format: desktop reports carry a
    // dot-separated `filters` list under scheme 2 *and* scheme 3, while the Browser Extension
    // uses `regular_filters`, switching to commas at scheme 4. Keying off the scheme alone made
    // every scheme-3 desktop report parse as having no filters at all.
    const desktopRaw = url.searchParams.get('filters');
    const extensionRaw = url.searchParams.get('regular_filters');
    if (desktopRaw !== null && extensionRaw !== null) {
        return null;
    }
    const raw = desktopRaw ?? extensionRaw;
    if (!raw) {
        return null;
    }
    const separator = extensionRaw !== null && schemeVersion === '4' ? ',' : '.';
    const filterIds = new Set<number>();
    for (const part of raw.split(separator)) {
        const trimmed = part.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const filterId = Number(trimmed);
        if (
            !Number.isInteger(filterId) ||
            filterId <= 0 ||
            filterId > MAXIMUM_FILTER_ID ||
            String(filterId) !== trimmed
        ) {
            return null;
        }
        filterIds.add(filterId);
    }
    if (filterIds.size === 0 || filterIds.size > MAXIMUM_REPORTER_FILTERS) {
        return null;
    }
    return {
        filterIds: [...filterIds].sort((left, right) => left - right),
        schemeVersion,
    };
}

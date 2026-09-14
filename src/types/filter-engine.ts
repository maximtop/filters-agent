/**
 * Filtering engine generation of the prepared extension: MV2 webRequest or MV3
 * declarativeNetRequest.
 */
export const FilterEngine = {
    WebRequest: 'web-request',
    DeclarativeNetRequest: 'declarative-net-request',
} as const;

/**
 * Every FilterEngine value, for schemas and exhaustive listings.
 */
export const FILTER_ENGINE_VALUES = Object.values(FilterEngine);

/**
 * FilterEngine value.
 */
export type FilterEngine = (typeof FilterEngine)[keyof typeof FilterEngine];

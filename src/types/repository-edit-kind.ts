/**
 * Shapes of a repository edit: insert a new line, extend a shared rule, replace or remove an exact
 * line.
 */
export const RepositoryEditKind = {
    Insert: 'insert',
    ExtendDomains: 'extend_domains',
    Replace: 'replace',
    Remove: 'remove',
} as const;

/**
 * Every RepositoryEditKind value, for schemas and exhaustive listings.
 */
export const REPOSITORY_EDIT_KIND_VALUES = Object.values(RepositoryEditKind);

/**
 * RepositoryEditKind value.
 */
export type RepositoryEditKind = (typeof RepositoryEditKind)[keyof typeof RepositoryEditKind];

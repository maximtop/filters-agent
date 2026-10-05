/**
 * Result of one idempotent GitHub write: created, updated, or left unchanged.
 */
export const MutationOutcome = {
    Created: 'created',
    Updated: 'updated',
    Unchanged: 'unchanged',
} as const;

/**
 * MutationOutcome value.
 */
export type MutationOutcome = (typeof MutationOutcome)[keyof typeof MutationOutcome];

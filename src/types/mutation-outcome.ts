/**
 * Result of one idempotent GitHub write: created, updated, or left unchanged.
 */
export const MutationOutcome = {
    Created: 'created',
    Updated: 'updated',
    Unchanged: 'unchanged',
} as const;

/**
 * Every MutationOutcome value, for schemas and exhaustive listings.
 */
export const MUTATION_OUTCOME_VALUES = Object.values(MutationOutcome);

/**
 * MutationOutcome value.
 */
export type MutationOutcome = (typeof MutationOutcome)[keyof typeof MutationOutcome];

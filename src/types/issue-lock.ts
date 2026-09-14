import * as v from 'valibot';

/**
 * Schema for an ephemeral issue lock that prevents concurrent agent runs on the same issue.
 *
 * In the MVP the lock is not persisted as a GitHub label or marker comment — it is validated at
 * run-start and immediately before the PR write via the double re-fetch. A future phase may persist
 * it.
 */
export const IssueLockSchema = v.object({
    /**
     * The issue number being locked.
     */
    issue: v.pipe(v.number(), v.integer(), v.minValue(1)),

    /**
     * The `fix/<N>-<domain>` branch name that will be created.
     */
    branch: v.pipe(v.string(), v.regex(/^fix\/\d+-[\w.-]+$/)),

    /**
     * The entity holding the lock.
     */
    lockedBy: v.literal('adguard-agent'),

    /**
     * ISO 8601 timestamp when the lock expires.
     */
    lockExpiresAt: v.pipe(v.string(), v.isoTimestamp()),

    /**
     * URL of an existing PR if one was found during the pre-start check.
     */
    existingPr: v.optional(v.string()),
});

/**
 * An ephemeral lock that prevents two agent runs from working the same issue concurrently.
 */
export type IssueLock = v.InferOutput<typeof IssueLockSchema>;

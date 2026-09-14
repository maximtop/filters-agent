import { normalizeRule } from '../repo/rule-normalizer';

/**
 * Why a semantic candidate registration was accepted or rejected.
 */
export type CandidateAttemptReason = 'accepted' | 'duplicate' | 'limit_reached';

/**
 * Result of registering one candidate validation attempt.
 */
export interface CandidateAttemptRegistration {
    /**
     * Whether the candidate may proceed to factual validation.
     */
    accepted: boolean;

    /**
     * Canonical rule produced by the shared rule normalizer.
     */
    canonical: string;

    /**
     * Reason the candidate was accepted or rejected.
     */
    reason: CandidateAttemptReason;

    /**
     * One-based semantic attempt number, or null when the limit was already exhausted.
     */
    attemptNumber: number | null;

    /**
     * Number of distinct attempts still available after this registration.
     */
    remainingAttempts: number;
}

/**
 * Tracks a bounded set of semantically distinct candidate rules for one agent run.
 */
export class SemanticCandidateAttemptTracker {
    /**
     * Hard product limit for candidate validation attempts in one run.
     */
    private static readonly maximumAttempts = 3;

    /**
     * Configured attempt budget, never greater than the product limit.
     */
    private readonly limit: number;

    /**
     * One-based attempt number indexed by canonical rule.
     */
    private readonly attemptsByCanonical = new Map<string, number>();

    /**
     * Create a semantic candidate attempt tracker.
     *
     * @param limit - Positive attempt budget no greater than three.
     */
    constructor(limit = SemanticCandidateAttemptTracker.maximumAttempts) {
        if (
            !Number.isInteger(limit) ||
            limit <= 0 ||
            limit > SemanticCandidateAttemptTracker.maximumAttempts
        ) {
            throw new Error(
                'Candidate attempt limit must be a positive integer no greater than 3.',
            );
        }
        this.limit = limit;
    }

    /**
     * Number of semantically distinct candidates accepted so far.
     *
     * @returns Count of consumed validation attempts.
     */
    get attemptCount(): number {
        return this.attemptsByCanonical.size;
    }

    /**
     * Normalize and register a candidate if it is distinct and budget remains.
     *
     * Duplicate candidates return their original attempt number and do not consume budget.
     *
     * @param rule - Raw candidate rule proposed by the model.
     * @returns Registration decision with canonical identity and remaining budget.
     */
    register(rule: string): CandidateAttemptRegistration {
        const canonical = normalizeRule(rule).canonical;
        const existingAttempt = this.attemptsByCanonical.get(canonical);
        if (existingAttempt !== undefined) {
            return {
                accepted: false,
                canonical,
                reason: 'duplicate',
                attemptNumber: existingAttempt,
                remainingAttempts: this.limit - this.attemptCount,
            };
        }
        if (this.attemptCount >= this.limit) {
            return {
                accepted: false,
                canonical,
                reason: 'limit_reached',
                attemptNumber: null,
                remainingAttempts: 0,
            };
        }

        const attemptNumber = this.attemptCount + 1;
        this.attemptsByCanonical.set(canonical, attemptNumber);
        return {
            accepted: true,
            canonical,
            reason: 'accepted',
            attemptNumber,
            remainingAttempts: this.limit - this.attemptCount,
        };
    }
}

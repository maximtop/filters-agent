import * as v from 'valibot';
import { ProblemTypeSchema } from './issue-facts';

export const PolicyGateInputSchema = v.object({
    problemType: ProblemTypeSchema,
    siteCategory: v.optional(v.string()),
    firstPartyAd: v.boolean(),
    paywall: v.boolean(),
    antiAdblockWall: v.boolean(),
    germanAntiAdblock: v.boolean(),
    evidenceRefs: v.array(v.string()),
});

export type PolicyGateInput = v.InferOutput<typeof PolicyGateInputSchema>;

export const PolicyDecisionSchema = v.variant('decision', [
    v.object({ decision: v.literal('allow_rule_generation'), reasons: v.array(v.string()) }),
    v.object({ decision: v.literal('needs_human_review'), reasons: v.array(v.string()) }),
    v.object({ decision: v.literal('propose_close'), reasons: v.array(v.string()) }),
]);

export type PolicyDecision = v.InferOutput<typeof PolicyDecisionSchema>;

import * as v from 'valibot';
import { IssueFactsSchema } from './issue-facts';
import { PolicyDecisionSchema } from './policy';
import { RuleProposalSchema } from './rule-proposal';
import { SiteAnalysisReportSchema } from './site-analysis';
import { ValidationResultSchema } from './validation';

export const EvidencePackSchema = v.object({
    issue: IssueFactsSchema,
    /**
     * Site analysis report (populated when browser tools are available; undefined for
     * reasoning-only analyze).
     */
    analysis: v.optional(SiteAnalysisReportSchema),
    policyDecision: PolicyDecisionSchema,
    ruleProposal: v.optional(RuleProposalSchema),
    validation: v.optional(ValidationResultSchema),
    screenshotsBefore: v.array(v.string()),
    screenshotsAfter: v.array(v.string()),
    harPath: v.optional(v.string()),
    domSnapshotPath: v.optional(v.string()),
    reasoning: v.string(),
});

export type EvidencePack = v.InferOutput<typeof EvidencePackSchema>;

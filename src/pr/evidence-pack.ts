import type { EvidencePack } from '../types/evidence-pack';
import type { IssueFacts } from '../types/issue-facts';
import { FixOutcomeKind, type FixOutcome } from './fix-outcome';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import { RuleType } from '../types/rule-proposal';

/**
 * Optional browser/analysis artifacts collected during the run.
 */
export interface EvidenceArtifacts {
    /**
     * Before screenshots (file paths or artifact IDs).
     */
    screenshotsBefore?: string[];

    /**
     * After screenshots (file paths or artifact IDs).
     */
    screenshotsAfter?: string[];

    /**
     * Path to the redacted HAR file.
     */
    harPath?: string;

    /**
     * Path to the DOM snapshot file.
     */
    domSnapshotPath?: string;
}

/**
 * Detect the broad rule type (network vs cosmetic) from a raw rule string.
 *
 * Uses `normalizeRule` — which relies on the exported `COSMETIC_SEPARATORS` (Task 0) — so that
 * scriptlet forms (`#%#`, `#$#`) and procedural exceptions (`#@?#`) are classified as cosmetic
 * rather than falling through to the network branch. This avoids a fragile `includes('#')` check.
 *
 * @param rule - The raw filter rule line.
 * @returns `'cosmetic'` for cosmetic/scriptlet rules, `'network'` otherwise.
 */
export function detectRuleType(rule: string): RuleType {
    const normalized = normalizeRule(rule);
    if (normalized.kind === RuleKind.Cosmetic || normalized.kind === RuleKind.Scriptlet) {
        return RuleType.Cosmetic;
    }
    return RuleType.Network;
}

/**
 * Assemble an `EvidencePack` from the parsed issue, the agent's fix decision, and optional browser
 * artifacts.
 *
 * For `draft_pr` outcomes the rule proposal and policy decision are carried directly from the
 * outcome. For `propose_close` outcomes only the policy decision and reasoning are included (no
 * rule proposal). For `analysis_only` outcomes a `needs_human_review` policy decision is
 * synthesized so the pack schema's required `policyDecision` field is always satisfied. The
 * `evidenceSummary` from the outcome is folded into `reasoning` (the `EvidencePack` schema has no
 * separate evidence-summary field).
 *
 * @param issue - The parsed issue facts.
 * @param outcome - The parsed agent fix decision.
 * @param artifacts - Optional browser/analysis artifacts.
 * @returns An `EvidencePack` ready for the PR/comment builders.
 */
export function assembleEvidencePack(
    issue: IssueFacts,
    outcome: FixOutcome,
    artifacts?: EvidenceArtifacts,
): EvidencePack {
    const screenshotsBefore = artifacts?.screenshotsBefore ?? [];
    const screenshotsAfter = artifacts?.screenshotsAfter ?? [];
    const harPath = artifacts?.harPath;
    const domSnapshotPath = artifacts?.domSnapshotPath;

    if (outcome.outcome === FixOutcomeKind.DraftPr) {
        // `evidenceSummary` exists on the draft_pr variant after narrowing.
        const reasoning = outcome.evidenceSummary
            ? `${outcome.evidenceSummary}\n\n${outcome.reasoning}`
            : outcome.reasoning;
        return {
            issue,
            policyDecision: outcome.policyDecision,
            ruleProposal: outcome.ruleProposal,
            screenshotsBefore,
            screenshotsAfter,
            harPath,
            domSnapshotPath,
            reasoning,
        };
    }

    if (outcome.outcome === FixOutcomeKind.ProposeClose) {
        // `evidenceSummary` exists on the propose_close variant after narrowing.
        const reasoning = outcome.evidenceSummary
            ? `${outcome.evidenceSummary}\n\n${outcome.reasoning}`
            : outcome.reasoning;
        return {
            issue,
            policyDecision: outcome.policyDecision,
            screenshotsBefore,
            screenshotsAfter,
            harPath,
            domSnapshotPath,
            reasoning,
        };
    }

    return {
        issue,
        policyDecision: {
            decision: 'needs_human_review',
            reasons: ['analysis-only outcome — no writes'],
        },
        screenshotsBefore,
        screenshotsAfter,
        harPath,
        domSnapshotPath,
        reasoning: outcome.reasoning,
    };
}

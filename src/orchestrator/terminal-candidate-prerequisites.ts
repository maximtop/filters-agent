/**
 * What a draft's candidate must satisfy before `finish_fix` may lock it, checked while the model
 * can still fix it: the rule is scoped to the reported domain alone, and its placement is the one
 * the deterministic resolver returned for exactly this rule.
 *
 * Both are retryable prerequisites of the terminal judgement (`terminal-outcome-validator`), kept
 * here so that module stays inside the repo's ~500-line rule.
 */
import { placementRuleTypeForCandidate } from '../repo/candidate-rule-type';
import { normalizeRule } from '../repo/rule-normalizer';
import type { FinishFixValidationRejection } from '../types/terminal-rejection';
import {
    normalizePlacementDomain,
    placementMatches,
    reportedDomainFromAllowedTargets,
    type CandidatePlacementResolution,
    type DraftFixOutcome,
} from './agent-runtime-candidate-context';
import { candidateScopeProblem, normalizeScopeDomain } from './candidate-scope';
import type { TerminalValidationView } from './terminal-validation-view';

/**
 * Return a draft whose rule is not scoped to the reported domain alone to the model, while it can
 * still fix it.
 *
 * The safety gate refuses such a draft after the run has sealed, and the model never learns why: on
 * nottinghampost.com a vision-verified fix ended as analysis-only because the submitted rule was
 * the merged line of an extension plan (the existing rule's three domains plus the reported one).
 * The common way here is exactly that, so the recovery names it: submit the rule for the reported
 * domain alone and let the host extend the existing rule.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid draft decision proposed by the model.
 * @returns Retryable scope prerequisite, or undefined when the draft is scoped as required.
 */
export function validateCandidateScope(
    view: TerminalValidationView,
    outcome: DraftFixOutcome,
): FinishFixValidationRejection | undefined {
    const reportedDomain = reportedDomainFromAllowedTargets(view.allowedTargetUrls);
    if (reportedDomain === undefined) {
        return undefined;
    }
    const candidate = normalizeRule(outcome.ruleProposal.rule);
    const problem = candidateScopeProblem(candidate, reportedDomain);
    if (problem === undefined) {
        return undefined;
    }
    return {
        error:
            `${problem} When the fix extends an existing rule's domain list, the candidate is ` +
            'still the rule scoped to the reported domain alone: validate that rule with ' +
            'apply_rule, submit it in finish_fix, and the host merges it into the existing rule.',
        errorKind: 'candidate_scope_invalid',
        retryable: true,
        requiredAction: 'scope_candidate_to_reported_domain',
        requiredTool: 'apply_rule',
        candidateRule: candidate.canonical,
        expectedTargetDomain: normalizeScopeDomain(reportedDomain),
    };
}

/**
 * Bind a draft proposal to the latest successful candidate-specific placement resolution.
 *
 * The model still chooses the candidate semantics. This check only prevents it from rewriting
 * deterministic filter, file, insertion, confidence, or alternative-placement facts after the
 * resolver has returned them.
 *
 * @param view - Read-only projection of the run the judgement reads.
 * @param outcome - Schema-valid draft decision proposed by the model.
 * @returns Retryable placement prerequisite, or undefined when the proposal is mechanically
 * bound.
 */
export function validateCandidatePlacement(
    view: TerminalValidationView,
    outcome: DraftFixOutcome,
): FinishFixValidationRejection | undefined {
    if (!view.baseToolNames.has('resolve_placement')) {
        return undefined;
    }
    const candidate = normalizeRule(outcome.ruleProposal.rule);
    const ruleType = placementRuleTypeForCandidate(candidate);
    const reportedHostRaw = reportedDomainFromAllowedTargets(view.allowedTargetUrls);
    const reportedHost = reportedHostRaw ? normalizePlacementDomain(reportedHostRaw) : undefined;
    let applicable: CandidatePlacementResolution | undefined;
    for (let index = view.candidatePlacementResolutions.length - 1; index >= 0; index -= 1) {
        const entry = view.candidatePlacementResolutions[index]!;
        if (
            entry.candidateCanonical === candidate.canonical &&
            entry.ruleType === ruleType &&
            (reportedHost === undefined || entry.targetDomain === reportedHost)
        ) {
            applicable = entry;
            break;
        }
    }
    if (!applicable) {
        return {
            error:
                'Call resolve_placement with this exact candidateRule, targetDomain, and ' +
                'syntax-derived ruleType before finish_fix.',
            errorKind: 'candidate_placement_resolution_required',
            retryable: true,
            requiredAction: 'resolve_candidate_placement',
            requiredTool: 'resolve_placement',
            candidateRule: candidate.canonical,
            expectedRuleType: ruleType ?? null,
            expectedTargetDomain: reportedHost ?? null,
        };
    }
    if (placementMatches(outcome.ruleProposal.placement, applicable.resolution)) {
        return undefined;
    }
    const { reasons: _reasons, ...expectedPlacement } = applicable.resolution;
    return {
        error:
            'The draft placement does not match the latest deterministic resolver result for ' +
            'this candidate. Copy the resolver placement fields exactly.',
        errorKind: 'candidate_placement_mismatch',
        retryable: true,
        requiredAction: 'use_resolved_candidate_placement',
        requiredTool: 'finish_fix',
        candidateRule: candidate.canonical,
        targetDomain: applicable.targetDomain,
        ruleType: applicable.ruleType,
        expectedPlacement,
        actualPlacement: outcome.ruleProposal.placement,
    };
}

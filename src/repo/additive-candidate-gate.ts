import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { PreparedFiltersCheckout } from '../local/filters-preparer';
import { scoreRisk } from '../risk/risk-scorer';
import { lintRule } from '../rules/aglint-linter';
import type { CandidatePatch } from '../types/fix-run-result';
import type { PolicyDecision } from '../types/policy';
import { RequiredAction, RiskLevel, type RuleRisk } from '../types/rule-proposal';
import { describeCulpritRemoval } from './culprit-removal';
import { describeCulpritReplacement, isSingleActionableRule } from './culprit-replacement';
import {
    filterScopeForPath,
    lockAdditiveSourceLocation,
    lockCulpritRemoval,
    lockCulpritReplacement,
    lockSharedRuleEdit,
    planCulpritRemoval,
    planCulpritReplacementEdit,
    planRepositoryEdit,
    sectionNameAtLine,
    type CulpritRemovalPlan,
    type CulpritSourceMappingOutcome,
    type RepositoryEditPlan,
    type ReviewCandidateOperation,
} from './repository-edit';
import { RuleKind, effectiveRuleScopes, normalizeRule } from './rule-normalizer';
import { describeSharedRuleExtension, type SharedRuleExtension } from './shared-rule-extension';
import { RepositoryEditKind } from '../types/repository-edit-kind';

export const CandidateRulePolaritySchema = v.picklist(['blocking', 'exception']);

/**
 * Whether the proposed rule adds filtering for the reported site or takes it away.
 */
export type CandidateRulePolarity = v.InferOutput<typeof CandidateRulePolaritySchema>;

/**
 * Finite gate a candidate must pass, or the exact gate that refused it.
 */
export const AdditiveCandidateGate = {
    /**
     * The proposed rule is not one valid blocking rule scoped to the reported site.
     */
    Syntax: 'syntax',

    /**
     * The selected filter file offers no additive placement for the proposed rule.
     */
    Placement: 'placement',

    /**
     * The reproduced culprit does not map to exactly one pinned source rule.
     */
    SourceMapping: 'source_mapping',

    /**
     * The replacement does not add exactly the reported domain to the existing shared rule.
     */
    SharedRuleStructure: 'shared_rule_structure',

    /**
     * The replacement is not a safe correction of that exact source rule.
     */
    CulpritReplacement: 'culprit_replacement',

    /**
     * The exact source rule is not one this repair path may remove.
     */
    CulpritRemoval: 'culprit_removal',

    /**
     * The deterministic policy decision does not allow proposing a rule for this report.
     */
    Policy: 'policy',

    /**
     * The proposed insertion could not be locked to the exact source snapshot.
     */
    SourceLock: 'source_lock',

    /**
     * The proposed rule requires human review before any verification may credit it.
     */
    Risk: 'risk',

    /**
     * The candidate could not be applied beside the published baseline.
     */
    CandidateApplication: 'candidate_application',

    /**
     * The reported target was still observed with the candidate applied.
     */
    TargetRemoval: 'target_removal',

    /**
     * The inspected page was no longer usable with the candidate applied.
     */
    PageUsability: 'page_usability',

    /**
     * The expected behaviour was still not working with the candidate applied.
     */
    BehaviorRestoration: 'behavior_restoration',

    /**
     * The candidate removed filtering the reported baseline was performing.
     */
    FilteringRegression: 'filtering_regression',
} as const;

/**
 * Every AdditiveCandidateGate value, for schemas and exhaustive listings.
 */
export const ADDITIVE_CANDIDATE_GATE_VALUES = Object.values(AdditiveCandidateGate);

export const AdditiveCandidateGateSchema = v.picklist(ADDITIVE_CANDIDATE_GATE_VALUES);

/**
 * AdditiveCandidateGate value.
 */
export type AdditiveCandidateGate =
    (typeof AdditiveCandidateGate)[keyof typeof AdditiveCandidateGate];

/**
 * Stable sanitized description of every gate refusal.
 *
 * These carry no path, argument vector, or subprocess output: a refusal is retained as rejected
 * evidence, and the exact target it refers to is already named by the candidate itself.
 */
const GATE_DETAILS: Readonly<Record<AdditiveCandidateGate, string>> = Object.freeze({
    [AdditiveCandidateGate.Syntax]:
        'The proposed rule is not one valid blocking rule scoped to the reported site.',
    [AdditiveCandidateGate.Placement]:
        'The selected filter file offers no additive placement for the proposed rule.',
    [AdditiveCandidateGate.SourceMapping]:
        'The reproduced culprit does not map to exactly one pinned source rule.',
    [AdditiveCandidateGate.SharedRuleStructure]:
        'The replacement does not add exactly the reported domain to the existing shared rule.',
    [AdditiveCandidateGate.CulpritReplacement]:
        'The replacement is not a safe correction of that exact source rule.',
    [AdditiveCandidateGate.CulpritRemoval]:
        'The exact source rule is not one this repair path may remove.',
    [AdditiveCandidateGate.Policy]:
        'The deterministic policy decision does not allow proposing a rule for this report.',
    [AdditiveCandidateGate.SourceLock]:
        'The proposed insertion could not be locked to the exact source snapshot.',
    [AdditiveCandidateGate.Risk]:
        'The proposed rule requires human review before any verification may credit it.',
    [AdditiveCandidateGate.CandidateApplication]:
        'The candidate could not be applied beside the published baseline.',
    [AdditiveCandidateGate.TargetRemoval]:
        'The reported target was still observed with the candidate applied.',
    [AdditiveCandidateGate.PageUsability]:
        'The inspected page was no longer usable with the candidate applied.',
    [AdditiveCandidateGate.BehaviorRestoration]:
        'The expected behaviour was still not working with the candidate applied.',
    [AdditiveCandidateGate.FilteringRegression]:
        'The candidate removed filtering the reported baseline was performing.',
});

/**
 * One proposed additive change and everything its static gates need.
 */
export interface AdditiveCandidateRequest {
    /**
     * Exact single-line rule proposed for addition.
     */
    rule: string;

    /**
     * Repository-relative target filter file the agent selected.
     */
    filePath: string;

    /**
     * Canonical reported hostname the candidate must be scoped to.
     */
    reportedDomain: string;

    /**
     * Deterministic policy decision already computed for this issue.
     */
    policy: PolicyDecision;

    /**
     * Polarity the proposed rule must have; omitted means an ordinary blocking rule.
     */
    polarity?: CandidateRulePolarity;

    /**
     * Prepared clean source snapshot, immutable for this run.
     */
    source: PreparedFiltersCheckout;
}

/**
 * A candidate whose every static gate passed, bound to one exact source location.
 */
export interface AcceptedAdditiveCandidate {
    /**
     * Exact single-line rule the candidate adds.
     */
    rule: string;

    /**
     * SHA-256 of the exact line this candidate proposes — the added line, the replacement line, or,
     * for a removal, the published culprit the environment deletes. It is the digest phase C proves
     * it executed, which for a removal is not the pinned source line {@link rule} names.
     */
    candidateDigest: string;

    /**
     * Locked exact operation, including its insertion-boundary digest for an addition.
     */
    operation: ReviewCandidateOperation;

    /**
     * Wider domain scope this candidate touches when it edits an existing shared rule; absent when
     * the candidate stands alone and affects only the reported site.
     */
    sharedRule?: SharedRuleExtension;

    /**
     * Exact published line this candidate replaces or deletes; present only when the candidate acts
     * on a rule reproduced from executed published content, and absent for every additive
     * candidate.
     */
    publishedCulprit?: string;

    /**
     * Filter-directory scope owning the target file.
     */
    filterScope: string | null;

    /**
     * Named section owning the insertion line, or null when the line is unsectioned.
     */
    sectionName: string | null;

    /**
     * Risk recomputed from the rule, never taken from model output.
     */
    risk: RuleRisk;

    /**
     * Publisher payload that binds to exactly this operation.
     */
    patch: CandidatePatch;
}

/**
 * Accepted candidate, or the exact gate that refused it.
 */
export type AdditiveCandidateGateOutcome =
    | {
          /**
           * Discriminator for an accepted candidate.
           */
          accepted: true;

          /**
           * Candidate bound to its exact source location.
           */
          candidate: AcceptedAdditiveCandidate;
      }
    | {
          /**
           * Discriminator for a refused candidate.
           */
          accepted: false;

          /**
           * Exact gate that refused it.
           */
          failedGate: AdditiveCandidateGate;

          /**
           * SHA-256 of the proposed rule, retained as rejected evidence.
           */
          candidateDigest: string;

          /**
           * Stable sanitized reason, carrying no path or subprocess output.
           */
          detail: string;
      };

/**
 * Normalize the runner-bound reported hostname the way effective rule scopes are normalized.
 *
 * A leading `www.` and a trailing root dot are ignored so a first-party scope compares equal to the
 * hostname the report named, matching what {@link effectiveRuleScopes} returns for an inferred
 * first-party network scope.
 *
 * @param reportedDomain - Runner-bound reported hostname, never model input.
 * @returns Comparable hostname.
 */
function comparableReportedDomain(reportedDomain: string): string {
    return reportedDomain
        .trim()
        .toLowerCase()
        .replace(/^www\./u, '')
        .replace(/\.$/u, '');
}

/**
 * Detect whether the planned target file already carries the proposed rule.
 *
 * Canonical rather than literal comparison, so a candidate that only reorders an existing rule's
 * modifiers is still recognized as already placed. The planner resolved this path from a canonical
 * location it proved to be inside the checkout, so the scan is read-only and contained.
 *
 * @param checkoutPath - Prepared clean source checkout.
 * @param filePath - Planner-normalized repository-relative target file.
 * @param canonical - Canonical form of the proposed rule.
 * @returns Whether an equivalent rule already occupies the target file.
 */
function targetFileCarriesRule(checkoutPath: string, filePath: string, canonical: string): boolean {
    const lines = readFileSync(join(realpathSync(checkoutPath), filePath), 'utf8').split(/\r?\n/u);
    return lines.some((line) => normalizeRule(line).canonical === canonical);
}

/**
 * Decide whether a proposed line is one valid rule of the required polarity scoped to the report.
 *
 * Both sibling gates share this definition so a candidate can never be accepted by one of them on
 * syntax terms the other would refuse.
 *
 * An exception is held to a stronger scope requirement than a blocking rule without a check of its
 * own: {@link effectiveRuleScopes} infers a first-party scope only for a non-exception rule, so the
 * scope condition below can be satisfied only by an exception that names the reported domain
 * explicitly through a cosmetic prefix or a `$domain=` modifier. An allowlist for the bare host,
 * which would disable every official filter on it, has no explicit scope and is refused.
 *
 * @param request - Proposed rule, reported domain, and required polarity.
 * @returns Whether the proposed line is well-formed and scoped to exactly the reported site.
 */
function isScopedCandidateRule(request: AdditiveCandidateRequest): boolean {
    const rule = request.rule;
    const normalized = normalizeRule(rule);
    if (
        rule.length === 0 ||
        /[\r\n]/u.test(rule) ||
        !lintRule(rule, { repoRoot: request.source.checkoutPath }).valid ||
        !([RuleKind.Network, RuleKind.Cosmetic, RuleKind.Scriptlet] as RuleKind[]).includes(
            normalized.kind,
        ) ||
        normalized.isException !== (request.polarity === 'exception')
    ) {
        return false;
    }
    const scopes = effectiveRuleScopes(normalized, request.reportedDomain);
    return scopes.length === 1 && scopes[0] === comparableReportedDomain(request.reportedDomain);
}

/**
 * Run every static gate an additive candidate must pass before phase C may begin.
 *
 * Gates run in one fixed order — syntax, placement, policy, source lock, risk — and the first
 * failure wins, so the gate a rejected candidate names is reproducible rather than dependent on
 * evaluation accidents.
 *
 * An exception is held to a stronger scope requirement than a blocking rule without a gate of its
 * own: {@link effectiveRuleScopes} infers a first-party scope only for a non-exception rule, so the
 * scope check below can be satisfied only by an exception that names the reported domain explicitly
 * through a cosmetic prefix or a `$domain=` modifier. An allowlist for the bare host, which would
 * disable every official filter on it, has no explicit scope and is refused.
 *
 * @param request - Proposed rule, target, reported domain, polarity, policy, and source snapshot.
 * @returns Accepted candidate bound to one exact insertion location, or the failed gate.
 */
export function gateAdditiveCandidate(
    request: AdditiveCandidateRequest,
): AdditiveCandidateGateOutcome {
    const rule = request.rule;
    const candidateDigest = createHash('sha256').update(rule).digest('hex');

    /**
     * Retain the proposed rule as rejected evidence naming the gate that refused it.
     *
     * @param failedGate - Exact gate that refused the candidate.
     * @param detail - Stable sanitized reason.
     * @returns Refused gate outcome.
     */
    const refuse = (
        failedGate: AdditiveCandidateGate,
        detail: string = GATE_DETAILS[failedGate],
    ): AdditiveCandidateGateOutcome => ({ accepted: false, failedGate, candidateDigest, detail });

    const normalized = normalizeRule(rule);
    if (!isScopedCandidateRule(request)) {
        return refuse(AdditiveCandidateGate.Syntax);
    }

    let plan: RepositoryEditPlan;
    try {
        plan = planRepositoryEdit(request.source.checkoutPath, request.filePath, rule);
        // The planner normalizes the model's path, so every later step uses `plan.filePath`:
        // locking a different path than the one that was planned is exactly the drift a verified
        // patch must never contain.
        if (
            plan.edit.kind !== RepositoryEditKind.Insert ||
            targetFileCarriesRule(request.source.checkoutPath, plan.filePath, normalized.canonical)
        ) {
            return refuse(AdditiveCandidateGate.Placement);
        }
    } catch {
        return refuse(AdditiveCandidateGate.Placement);
    }

    if (request.policy.decision !== 'allow_rule_generation') {
        return refuse(AdditiveCandidateGate.Policy);
    }

    const locked = lockAdditiveSourceLocation(
        request.source.checkoutPath,
        request.source.provenance.commit,
        plan.filePath,
        rule,
        plan.edit,
    );
    // Each binding failure code has its own sanitized sentence, so the exact lock invariant that
    // refused the insertion stays readable in the rejected evidence.
    if (locked.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceLock, locked.detail);
    }

    const risk = scoreRisk(rule, { trustedReportedDomain: request.reportedDomain });
    if (risk.level === RiskLevel.Blocker || risk.requiredAction === RequiredAction.HumanOnly) {
        return refuse(AdditiveCandidateGate.Risk);
    }

    const lines = locked.preimage.lines;
    const insertionPoint = locked.operation.line - 1;
    return {
        accepted: true,
        candidate: {
            rule,
            candidateDigest,
            operation: locked.operation,
            filterScope: filterScopeForPath(plan.filePath) ?? null,
            sectionName:
                lines.length === 0
                    ? null
                    : (sectionNameAtLine(lines, Math.min(insertionPoint, lines.length - 1)) ??
                      null),
            risk,
            patch: {
                rule,
                ruleType: normalized.kind === RuleKind.Network ? 'network' : 'cosmetic',
                ...(normalized.syntaxKind ? { syntaxKind: normalized.syntaxKind } : {}),
                filePath: plan.filePath,
                repositoryEdit: { ...plan.edit, insertionPoint },
            },
        },
    };
}

/**
 * Run every static gate a constrained shared-rule edit must pass before phase C may begin.
 *
 * Gates run in the same fixed order as {@link gateAdditiveCandidate} — syntax, placement, structure,
 * policy, source lock, risk — with one inversion: this gate requires the planner to resolve a
 * domain extension, where the additive gate requires an insertion. The two are siblings, so a
 * candidate is never silently reinterpreted as the other kind of change.
 *
 * The accepted candidate's `rule` is the single-domain rule the reported site executes, not the
 * replacement line: those are the same filtering state for that site, and it is the state phase C
 * applies and the state `applyRepositoryEdit` re-derives the replacement from.
 *
 * @param request - Proposed rule, target, reported domain, policy, and source snapshot.
 * @returns Accepted candidate bound to one exact source line, or the failed gate.
 */
export function gateSharedRuleEditCandidate(
    request: AdditiveCandidateRequest,
): AdditiveCandidateGateOutcome {
    const rule = request.rule;
    const candidateDigest = createHash('sha256').update(rule).digest('hex');

    /**
     * Retain the proposed rule as rejected evidence naming the gate that refused it.
     *
     * @param failedGate - Exact gate that refused the candidate.
     * @param detail - Stable sanitized reason.
     * @returns Refused gate outcome.
     */
    const refuse = (
        failedGate: AdditiveCandidateGate,
        detail: string = GATE_DETAILS[failedGate],
    ): AdditiveCandidateGateOutcome => ({ accepted: false, failedGate, candidateDigest, detail });

    const normalized = normalizeRule(rule);
    if (!isScopedCandidateRule(request)) {
        return refuse(AdditiveCandidateGate.Syntax);
    }

    let plan: RepositoryEditPlan;
    try {
        plan = planRepositoryEdit(request.source.checkoutPath, request.filePath, rule);
        // This gate is not a general edit gate: a candidate no existing shared rule owns resolves
        // to an insertion, which belongs to the additive sibling rather than here. A file the
        // candidate cannot be inserted into throws out of the planner and lands in the same
        // refusal.
        if (plan.edit.kind !== RepositoryEditKind.ExtendDomains) {
            return refuse(AdditiveCandidateGate.Placement);
        }
    } catch {
        return refuse(AdditiveCandidateGate.Placement);
    }
    const edit = plan.edit;

    const extension = describeSharedRuleExtension(rule, edit.originalRule, edit.replacementRule);
    if (!extension) {
        return refuse(AdditiveCandidateGate.SharedRuleStructure);
    }

    if (request.policy.decision !== 'allow_rule_generation') {
        return refuse(AdditiveCandidateGate.Policy);
    }

    const locked = lockSharedRuleEdit(
        request.source.checkoutPath,
        request.source.provenance.commit,
        plan.filePath,
        rule,
        edit,
    );
    // Each binding failure code has its own sanitized sentence, so the exact lock invariant that
    // refused the edit stays readable in the rejected evidence.
    if (locked.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceLock, locked.detail);
    }

    // The wider scope this edit also serves is a real blast-radius fact, and it is derived from the
    // structural predicate rather than asserted by the caller.
    const risk = scoreRisk(rule, {
        trustedReportedDomain: request.reportedDomain,
        affectsMultipleKnownSites: extension.retainedScopes.length > 0,
    });
    if (risk.level === RiskLevel.Blocker || risk.requiredAction === RequiredAction.HumanOnly) {
        return refuse(AdditiveCandidateGate.Risk);
    }

    const lines = locked.preimage.lines;
    return {
        accepted: true,
        candidate: {
            rule,
            candidateDigest,
            operation: locked.operation,
            sharedRule: extension,
            filterScope: filterScopeForPath(plan.filePath) ?? null,
            sectionName:
                lines.length === 0
                    ? null
                    : (sectionNameAtLine(lines, Math.min(edit.line - 1, lines.length - 1)) ?? null),
            risk,
            patch: {
                rule,
                ruleType: normalized.kind === RuleKind.Network ? 'network' : 'cosmetic',
                ...(normalized.syntaxKind ? { syntaxKind: normalized.syntaxKind } : {}),
                filePath: plan.filePath,
                repositoryEdit: edit,
            },
        },
    };
}

/**
 * One proposed correction of an exact published rule and everything its static gates need.
 */
export interface CulpritEditCandidateRequest {
    /**
     * Exact line reproduced from the executed published filter content.
     */
    publishedCulprit: string;

    /**
     * Complete replacement line proposed for that rule.
     */
    replacementRule: string;

    /**
     * Canonical reported hostname whose breakage this correction must repair.
     */
    reportedDomain: string;

    /**
     * Deterministic policy decision already computed for this issue.
     */
    policy: PolicyDecision;

    /**
     * Prepared clean source snapshot, immutable for this run.
     */
    source: PreparedFiltersCheckout;
}

/**
 * Run every static gate an exact culprit correction must pass before phase C may begin.
 *
 * Gates run in one fixed order — syntax, source mapping, replacement structure, policy, source
 * lock, risk — and the first failure wins, so the gate a rejected candidate names is reproducible.
 * This is a sibling of {@link gateAdditiveCandidate} and {@link gateSharedRuleEditCandidate} rather
 * than a mode of either: its candidate is neither scoped to the reported site nor authored by the
 * report, so no candidate is ever silently reinterpreted as another kind of change.
 *
 * The target file is derived from the mapping, never selected by the agent: the one file that
 * carries the culprit is a repository fact, and accepting a model's file choice here would be a way
 * to edit an unrelated line that happens to look similar.
 *
 * @param request - Published culprit, proposed replacement, reported domain, policy, and snapshot.
 * @returns Accepted candidate bound to one exact source line, or the failed gate.
 */
export function gateCulpritEditCandidate(
    request: CulpritEditCandidateRequest,
): AdditiveCandidateGateOutcome {
    const rule = request.replacementRule;
    const candidateDigest = createHash('sha256').update(rule).digest('hex');

    /**
     * Retain the proposed replacement as rejected evidence naming the gate that refused it.
     *
     * @param failedGate - Exact gate that refused the candidate.
     * @param detail - Stable sanitized reason.
     * @returns Refused gate outcome.
     */
    const refuse = (
        failedGate: AdditiveCandidateGate,
        detail: string = GATE_DETAILS[failedGate],
    ): AdditiveCandidateGateOutcome => ({ accepted: false, failedGate, candidateDigest, detail });

    const normalized = normalizeRule(rule);
    if (
        !isSingleActionableRule(request.publishedCulprit, {
            repoRoot: request.source.checkoutPath,
        }) ||
        !isSingleActionableRule(rule, { repoRoot: request.source.checkoutPath })
    ) {
        return refuse(AdditiveCandidateGate.Syntax);
    }

    let mapping: CulpritSourceMappingOutcome;
    try {
        mapping = planCulpritReplacementEdit(request.source, request.publishedCulprit, rule);
    } catch {
        return refuse(AdditiveCandidateGate.SourceMapping);
    }
    if (mapping.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceMapping);
    }
    const plan = mapping.plan;
    const edit = plan.edit;

    // Compared against the *source* rule, which the mapping already proved canonically equal to the
    // published culprit: the bytes this run will replace are the bytes the gate must judge.
    const replacement = describeCulpritReplacement(edit.originalRule, rule);
    if (!replacement) {
        return refuse(AdditiveCandidateGate.CulpritReplacement);
    }

    if (request.policy.decision !== 'allow_rule_generation') {
        return refuse(AdditiveCandidateGate.Policy);
    }

    const locked = lockCulpritReplacement(
        request.source.checkoutPath,
        request.source.provenance.commit,
        plan.filePath,
        edit,
    );
    // Each binding failure code has its own sanitized sentence, so the exact lock invariant that
    // refused the correction stays readable in the rejected evidence.
    if (locked.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceLock, locked.detail);
    }

    // The scopes the corrected rule keeps governing are a real blast-radius fact, and they are
    // derived from the structural predicate rather than asserted by the caller.
    const risk = scoreRisk(rule, {
        trustedReportedDomain: request.reportedDomain,
        affectsMultipleKnownSites: replacement.affectedScopes.length > 1,
    });
    if (risk.level === RiskLevel.Blocker || risk.requiredAction === RequiredAction.HumanOnly) {
        return refuse(AdditiveCandidateGate.Risk);
    }

    const lines = locked.preimage.lines;
    return {
        accepted: true,
        candidate: {
            rule,
            candidateDigest,
            operation: locked.operation,
            publishedCulprit: request.publishedCulprit,
            filterScope: filterScopeForPath(plan.filePath) ?? null,
            sectionName:
                lines.length === 0
                    ? null
                    : (sectionNameAtLine(lines, Math.min(edit.line - 1, lines.length - 1)) ?? null),
            risk,
            patch: {
                rule,
                ruleType: normalized.kind === RuleKind.Network ? 'network' : 'cosmetic',
                ...(normalized.syntaxKind ? { syntaxKind: normalized.syntaxKind } : {}),
                filePath: plan.filePath,
                repositoryEdit: edit,
            },
        },
    };
}

/**
 * One proposed deletion of an exact published rule and everything its static gates need.
 */
export interface CulpritRemoveCandidateRequest {
    /**
     * Exact line reproduced from the executed published filter content.
     */
    publishedCulprit: string;

    /**
     * Canonical reported hostname whose breakage this deletion must repair.
     */
    reportedDomain: string;

    /**
     * Deterministic policy decision already computed for this issue.
     */
    policy: PolicyDecision;

    /**
     * Prepared clean source snapshot, immutable for this run.
     */
    source: PreparedFiltersCheckout;
}

/**
 * Run every static gate an exact culprit removal must pass before phase C may begin.
 *
 * Gates run in one fixed order — syntax, source mapping, removal structure, policy, source lock,
 * risk — and the first failure wins, so the gate a rejected candidate names is reproducible. This
 * is a sibling of {@link gateCulpritEditCandidate} rather than a mode of it: a deletion proposes no
 * new line at all, so no candidate is ever silently reinterpreted as another kind of change.
 *
 * Risk is scored on the rule being deleted, because for a removal that rule _is_ the blast radius:
 * the wider the scope it governed, the more filtering the deletion takes away.
 *
 * @param request - Published culprit, reported domain, policy, and snapshot.
 * @returns Accepted candidate bound to one exact source line, or the failed gate.
 */
export function gateCulpritRemoveCandidate(
    request: CulpritRemoveCandidateRequest,
): AdditiveCandidateGateOutcome {
    const publishedCulprit = request.publishedCulprit;
    // Taken over the published line rather than the pinned source line: that is the line phase C
    // deletes and the line whose digest its proof carries, and canonical mapping lets the two
    // differ in bytes.
    const candidateDigest = createHash('sha256').update(publishedCulprit).digest('hex');

    /**
     * Retain the proposed deletion as rejected evidence naming the gate that refused it.
     *
     * @param failedGate - Exact gate that refused the candidate.
     * @param detail - Stable sanitized reason.
     * @returns Refused gate outcome.
     */
    const refuse = (
        failedGate: AdditiveCandidateGate,
        detail: string = GATE_DETAILS[failedGate],
    ): AdditiveCandidateGateOutcome => ({ accepted: false, failedGate, candidateDigest, detail });

    if (!isSingleActionableRule(publishedCulprit, { repoRoot: request.source.checkoutPath })) {
        return refuse(AdditiveCandidateGate.Syntax);
    }

    let mapping: CulpritSourceMappingOutcome<CulpritRemovalPlan>;
    try {
        mapping = planCulpritRemoval(request.source, publishedCulprit);
    } catch {
        return refuse(AdditiveCandidateGate.SourceMapping);
    }
    if (mapping.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceMapping);
    }
    const plan = mapping.plan;
    const edit = plan.edit;

    // Judges the *source* rule, which the mapping already proved canonically equal to the published
    // culprit: the bytes this run will delete are the bytes the gate must judge.
    const removal = describeCulpritRemoval(edit.originalRule);
    if (!removal) {
        return refuse(AdditiveCandidateGate.CulpritRemoval);
    }

    if (request.policy.decision !== 'allow_rule_generation') {
        return refuse(AdditiveCandidateGate.Policy);
    }

    const locked = lockCulpritRemoval(
        request.source.checkoutPath,
        request.source.provenance.commit,
        plan.filePath,
        edit,
    );
    // Each binding failure code has its own sanitized sentence, so the exact lock invariant that
    // refused the deletion stays readable in the rejected evidence.
    if (locked.kind === 'failed') {
        return refuse(AdditiveCandidateGate.SourceLock, locked.detail);
    }

    // The scopes the deleted rule governed are a real blast-radius fact, and they are derived from
    // the structural predicate rather than asserted by the caller.
    const risk = scoreRisk(edit.originalRule, {
        trustedReportedDomain: request.reportedDomain,
        affectsMultipleKnownSites: removal.affectedScopes.length > 1,
    });
    if (risk.level === RiskLevel.Blocker || risk.requiredAction === RequiredAction.HumanOnly) {
        return refuse(AdditiveCandidateGate.Risk);
    }

    const normalized = normalizeRule(edit.originalRule);
    const lines = locked.preimage.lines;
    return {
        accepted: true,
        candidate: {
            rule: edit.originalRule,
            candidateDigest,
            operation: locked.operation,
            publishedCulprit,
            filterScope: filterScopeForPath(plan.filePath) ?? null,
            sectionName:
                lines.length === 0
                    ? null
                    : (sectionNameAtLine(lines, Math.min(edit.line - 1, lines.length - 1)) ?? null),
            risk,
            patch: {
                rule: edit.originalRule,
                ruleType: normalized.kind === RuleKind.Network ? 'network' : 'cosmetic',
                ...(normalized.syntaxKind ? { syntaxKind: normalized.syntaxKind } : {}),
                filePath: plan.filePath,
                repositoryEdit: edit,
            },
        },
    };
}

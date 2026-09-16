import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { FixOutcomeKind, type FixOutcome } from '../pr/fix-outcome';
import { isIncorrectBlockingReport, type ProblemType } from '../types/issue-facts';
import {
    RuleKind,
    SINGLE_LINE_RULE_MESSAGE,
    effectiveRuleScopes,
    isSingleLineRule,
    normalizeRule,
} from '../repo/rule-normalizer';
import { DuplicateClass, RiskLevel, RuleType } from '../types/rule-proposal';
import type { DeclaredPlacement } from '../types/declared-placement';
import { planRepositoryEdit } from '../repo/repository-edit';
import { scoreRisk } from '../risk/risk-scorer';
import { lintRule } from '../rules/aglint-linter';
import { parseSafeCssInjectionRule } from '../rules/safe-css-injection';
import { RepositoryEditKind } from '../types/repository-edit-kind';

/**
 * Repository and issue context needed for deterministic candidate validation.
 */
export interface CandidateSafetyOptions {
    /**
     * Canonical hostname reported by the issue.
     */
    reportedDomain: string;

    /**
     * Local AdguardFilters checkout used to verify the target file and duplicates.
     */
    checkoutPath?: string;

    /**
     * Parsed problem class of the report driving this run.
     *
     * Exception rules are eligible only for incorrect-blocking reports, where a domain-scoped
     * exception is the dominant human remedy; for every other class they stay rejected.
     */
    problemType?: ProblemType;

    /**
     * The run's declared placement, rendered once at run start, when its instruction declares one.
     *
     * The gate re-plans the edit to verify the target, so it must plan the same edit the patch
     * will: against the declared file, appending at its end. Planning the routed way instead would
     * reject a declared placement for an ambiguity — a shared-rule owner elsewhere — that the
     * declaration has already settled.
     */
    declaredPlacement?: DeclaredPlacement;

    /**
     * Absolute paths of the files the run's host maintains inside the checkout: the declared
     * blocker-state file the between-phases application writes the candidate into.
     *
     * They are run state, not repository content, so the duplicate scan skips them; read like a
     * filter list, the file hands the gate the run's own candidate as an existing rule.
     */
    hostOwnedFiles?: readonly string[];
}

/**
 * Safe outcome after deterministic candidate validation.
 */
export interface CandidateSafetyDecision {
    /**
     * Original safe outcome or an analysis-only downgrade.
     */
    outcome: FixOutcome;

    /**
     * Explicit rejection reason, or null when no candidate was rejected.
     */
    rejectionReason: string | null;
}

/**
 * Error used internally to turn every unsafe candidate into an analysis-only result.
 */
class CandidateSafetyError extends Error {
    /**
     * Create a deterministic candidate rejection.
     *
     * @param message - Human-readable rejection reason.
     */
    constructor(message: string) {
        super(message);
        this.name = 'CandidateSafetyError';
    }
}

/**
 * Normalize a hostname for exact issue-scope comparison.
 *
 * @param domain - Raw hostname from issue or rule scope.
 * @returns Lowercase hostname without a leading `www.` or trailing root dot.
 */
function normalizeDomain(domain: string): string {
    return domain
        .trim()
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/\.$/, '');
}

/**
 * Map a parsed syntax kind to the proposal schema's intentionally broad rule type.
 *
 * Scriptlets use cosmetic-rule separators and remain part of the general `cosmetic` category; their
 * concrete `scriptlet` syntax is preserved separately by the runner.
 *
 * @param kind - Parsed rule kind returned by the normalizer.
 * @returns The compatible proposal rule type, or null for non-actionable input.
 */
function generalRuleTypeForKind(kind: RuleKind): RuleType | null {
    if (kind === RuleKind.Network) {
        return RuleType.Network;
    }
    if (kind === RuleKind.Cosmetic || kind === RuleKind.Scriptlet) {
        return RuleType.Cosmetic;
    }
    return null;
}

/**
 * Search repository filter files for an exact canonical duplicate without trusting model output.
 *
 * Hidden directories, dependency trees, and symbolic links are excluded so the scan remains inside
 * the checked-out filter corpus.
 *
 * @param checkoutPath - Verified local AdguardFilters checkout.
 * @param candidateCanonical - Canonical candidate rule to locate.
 * @param hostOwnedFiles - Absolute paths of the files the run's host maintains inside the checkout;
 *   skipped, since they hold the run's own applied candidate rather than repository content.
 * @returns Whether any regular `.txt` filter file already contains the exact candidate.
 */
function hasExactDuplicate(
    checkoutPath: string,
    candidateCanonical: string,
    hostOwnedFiles: readonly string[],
): boolean {
    const checkoutRoot = realpathSync(checkoutPath);
    // Entries below are real paths, so a host-owned file is matched by its real path too.
    const skippedFiles = new Set(
        hostOwnedFiles.map((file) => (existsSync(file) ? realpathSync(file) : resolve(file))),
    );
    const directories = [checkoutRoot];

    while (directories.length > 0) {
        const directory = directories.pop();
        if (!directory) {
            continue;
        }
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) {
                continue;
            }
            const entryPath = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    directories.push(entryPath);
                }
                continue;
            }
            if (
                entry.isFile() &&
                entry.name.endsWith('.txt') &&
                !skippedFiles.has(entryPath) &&
                readFileSync(entryPath, 'utf8')
                    .split(/\r?\n/)
                    .some((line) => normalizeRule(line).canonical === candidateCanonical)
            ) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Reject a candidate and preserve its original reasoning for the report-only PR.
 *
 * @param outcome - Unsafe draft-PR outcome.
 * @param reason - Deterministic rejection reason.
 * @returns Analysis-only safety decision.
 */
function rejectCandidate(outcome: FixOutcome, reason: string): CandidateSafetyDecision {
    const reasoning =
        'reasoning' in outcome && outcome.reasoning.length > 0
            ? `${outcome.reasoning} Candidate rejected: ${reason}`
            : `Candidate rejected: ${reason}`;
    return {
        outcome: { outcome: FixOutcomeKind.AnalysisOnly, reasoning },
        rejectionReason: reason,
    };
}

/**
 * Enforce deterministic publication invariants before a runtime candidate reaches the publisher.
 *
 * Unsafe drafts are downgraded to analysis-only so the publisher can still create its single
 * report-only PR. Safe drafts receive a recomputed risk payload rather than trusting model output.
 *
 * @param outcome - Parsed agent outcome.
 * @param options - Reported domain and checkout context.
 * @returns Safe outcome plus an explicit rejection reason when downgraded.
 */
export function enforceCandidateSafety(
    outcome: FixOutcome,
    options: CandidateSafetyOptions,
): CandidateSafetyDecision {
    if (outcome.outcome !== FixOutcomeKind.DraftPr) {
        return { outcome, rejectionReason: null };
    }

    try {
        const proposal = outcome.ruleProposal;
        if (outcome.policyDecision.decision !== 'allow_rule_generation') {
            throw new CandidateSafetyError('Policy does not allow rule generation.');
        }
        if (!proposal.productCompatibility.extension) {
            throw new CandidateSafetyError(
                'Candidate is not compatible with the browser extension.',
            );
        }
        if (!isSingleLineRule(proposal.rule)) {
            throw new CandidateSafetyError(SINGLE_LINE_RULE_MESSAGE);
        }

        const lint = lintRule(proposal.rule, { repoRoot: options.checkoutPath });
        if (!lint.valid) {
            throw new CandidateSafetyError(
                `Candidate failed deterministic lint: ${lint.problems
                    .map((problem) => problem.code)
                    .join(', ')}`,
            );
        }
        // AGLint carries no notion of the validator-owned CSS safety subset, so the old lint's
        // applicability check lives here as its own invariant: a candidate the validator could
        // never apply in phase C must not reach the publisher.
        const normalized = normalizeRule(proposal.rule);
        if (
            normalized.cssInjectionBody !== undefined &&
            parseSafeCssInjectionRule(proposal.rule).value === undefined
        ) {
            throw new CandidateSafetyError(
                'Candidate CSS injection is outside the validator-owned safe subset.',
            );
        }
        if (generalRuleTypeForKind(normalized.kind) !== proposal.ruleType) {
            throw new CandidateSafetyError(
                `Candidate ruleType ${proposal.ruleType} does not match parsed kind ${normalized.kind}.`,
            );
        }
        if (normalized.isException && !isIncorrectBlockingReport(options.problemType)) {
            throw new CandidateSafetyError(
                'Exception rules are only eligible for incorrect-blocking reports.',
            );
        }
        // The scope gate below carries the rest of the exception policy: effectiveRuleScopes
        // never infers a scope for an exception, so a generic `@@||host^` without $domain=
        // (or a cosmetic exception without a domain prefix) fails closed here.
        const expectedDomain = normalizeDomain(options.reportedDomain);
        const scopes = effectiveRuleScopes(normalized, expectedDomain).map(normalizeDomain);
        if (scopes.length !== 1 || scopes[0] !== expectedDomain) {
            throw new CandidateSafetyError(
                `Candidate must have exactly one positive scope for reported domain ${expectedDomain}.`,
            );
        }

        const risk = scoreRisk(proposal.rule, { trustedReportedDomain: expectedDomain });
        if (risk.level === RiskLevel.Blocker || risk.requiredAction === 'human_only') {
            throw new CandidateSafetyError(
                `Candidate risk is not publication-eligible: ${risk.level}/${risk.requiredAction}.`,
            );
        }

        if (!options.checkoutPath) {
            throw new CandidateSafetyError(
                'Candidate target cannot be verified without a checkout.',
            );
        }
        let repositoryPlan: ReturnType<typeof planRepositoryEdit>;
        try {
            repositoryPlan = planRepositoryEdit(
                options.checkoutPath,
                proposal.placement.filePath,
                proposal.rule,
                proposal.duplicateCheck.matches.map((match) => match.rule),
                options.declaredPlacement,
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new CandidateSafetyError(
                /ambiguous/iu.test(detail)
                    ? detail
                    : `Candidate target or repository placement is unsafe: ${detail}`,
            );
        }
        // Exceptions never resolve to a domain extension (the extension selector refuses them),
        // so a model-reported duplicate classification must not veto a valid exception insert.
        if (
            proposal.duplicateCheck.classification !== DuplicateClass.None &&
            !normalized.isException
        ) {
            const extensionEligibleClasses: DuplicateClass[] = [
                DuplicateClass.Semantic,
                DuplicateClass.CrossFilter,
                DuplicateClass.Subsumed,
            ];
            const extensionEligibleClass = extensionEligibleClasses.includes(
                proposal.duplicateCheck.classification,
            );
            const plannedEdit = extensionEligibleClass
                ? repositoryPlan.edit
                : { kind: RepositoryEditKind.Insert };
            if (plannedEdit.kind !== RepositoryEditKind.ExtendDomains) {
                throw new CandidateSafetyError(
                    'Candidate duplicate check did not resolve to a safe domain extension.',
                );
            }
        }
        const candidateCanonical = normalized.canonical;
        if (
            hasExactDuplicate(
                options.checkoutPath!,
                candidateCanonical,
                options.hostOwnedFiles ?? [],
            )
        ) {
            throw new CandidateSafetyError('Candidate rule already exists in the checkout.');
        }

        return {
            outcome: {
                ...outcome,
                ruleProposal: {
                    ...proposal,
                    risk,
                },
            },
            rejectionReason: null,
        };
    } catch (error) {
        const reason =
            error instanceof CandidateSafetyError
                ? error.message
                : `Candidate safety validation failed: ${(error as Error).message}`;
        return rejectCandidate(outcome, reason);
    }
}

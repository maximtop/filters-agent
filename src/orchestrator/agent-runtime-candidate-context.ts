/**
 * The path-free candidate vocabulary the {@link AgentRuntime} shares with the modules split out of
 * it: the per-run budgets, the candidate ledger key, prompt-safe target-URL binding, and the
 * placement comparison a terminal proposal is judged against.
 *
 * It holds no runtime state and imports nothing from the runtime, so the split modules never import
 * the runtime back.
 */
import { CandidateOperation } from '../environment/filtering-environment';
import { FixOutcomeKind, type FixOutcome } from '../pr/fix-outcome';
import type { PlacementResolution } from '../repo/placement-resolver';
import type { PlacementRuleType } from '../types/placement-rule-type';

/**
 * Maximum browser-bound executions of one semantic candidate after transient vision failures.
 */
export const MAX_CANDIDATE_VALIDATION_EXECUTIONS = 3;

/**
 * Maximum technical browser failures allowed for one prompt-safe target during a run.
 */
export const MAX_TECHNICAL_BROWSER_FAILURES_PER_TARGET = 3;

/**
 * Compose the candidate-ledger key shared by the attempt, outcome, and retry bookkeeping.
 *
 * The operation participates so an add, edit, and remove of the same rule text stay distinct
 * attempts instead of colliding as duplicates.
 *
 * @param operation - Candidate operation against the published baseline.
 * @param canonical - Canonical normalized rule text.
 * @returns Stable composed ledger key.
 */
export function candidateLedgerKey(operation: CandidateOperation, canonical: string): string {
    return `${operation}:${canonical}`;
}

/**
 * One successful deterministic placement resolution retained for an exact candidate.
 */
export interface CandidatePlacementResolution {
    /**
     * Canonical candidate rule supplied to the resolver.
     */
    candidateCanonical: string;

    /**
     * Normalized domain whose repository placement was resolved.
     */
    targetDomain: string;

    /**
     * Concrete placement category inferred from the candidate syntax.
     */
    ruleType: PlacementRuleType;

    /**
     * Schema-validated mechanical repository placement returned by the resolver.
     */
    resolution: PlacementResolution;
}

/**
 * Discriminator used to narrow a terminal outcome to its draft variant.
 */
interface DraftOutcomeDiscriminator {
    /**
     * Draft terminal variant.
     */
    outcome: typeof FixOutcomeKind.DraftPr;
}

/**
 * Draft outcome narrowed from the terminal decision union.
 */
export type DraftFixOutcome = Extract<FixOutcome, DraftOutcomeDiscriminator>;

/**
 * Placement payload carried by one draft rule proposal.
 */
export type DraftRulePlacement = DraftFixOutcome['ruleProposal']['placement'];

/**
 * Normalize one HTTP(S) URL for exact prompt-safe target binding.
 *
 * The fragment is preserved: single-page players keep the video identity there, so a check session
 * that navigates without it loads a different page than the reporter described and reports the
 * resulting emptiness as breakage.
 *
 * @param value - Untrusted URL from issue parsing or model arguments.
 * @returns Canonical URL including its fragment, or undefined for unsupported input.
 */
export function canonicalTargetUrl(value: string): string | undefined {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}

/**
 * Reduce one target URL to its fragment-insensitive identity.
 *
 * Fragments never reach the network, so fragment variants address the same document: they match the
 * same prompt-safe allow-list entry and share one failed-environment identity.
 *
 * @param value - Untrusted URL from issue parsing or model arguments.
 * @returns Canonical URL without its fragment, or undefined for unsupported input.
 */
export function targetUrlMatchKey(value: string): string | undefined {
    const canonical = canonicalTargetUrl(value);
    if (canonical === undefined) {
        return undefined;
    }
    const url = new URL(canonical);
    url.hash = '';
    return url.href;
}

/**
 * Bind one model-supplied target URL to the exact prompt-safe URL it addresses.
 *
 * The bound value always comes from the allow-list rather than from the model echo, so a model that
 * drops or rewrites the fragment still navigates to the URL the reporter supplied. An echo whose
 * document matches several allow-list fragments stays unbound instead of guessing between them.
 *
 * @param requested - Untrusted target URL echoed by the model.
 * @param allowedTargetUrls - Exact prompt-safe URLs extracted outside the model loop.
 * @returns Canonical allow-list URL, or undefined when unmatched or ambiguous.
 */
export function bindAllowedTargetUrl(
    requested: string,
    allowedTargetUrls: readonly string[],
): string | undefined {
    const canonical = canonicalTargetUrl(requested);
    if (canonical === undefined) {
        return undefined;
    }
    const allowed = allowedTargetUrls
        .map(canonicalTargetUrl)
        .filter((url): url is string => url !== undefined);
    if (allowed.includes(canonical)) {
        return canonical;
    }
    const requestedKey = targetUrlMatchKey(canonical);
    const documentVariants = allowed.filter((url) => targetUrlMatchKey(url) === requestedKey);
    return documentVariants.length === 1 ? documentVariants[0] : undefined;
}

/**
 * Derive the runner-bound reported hostname from the first valid prompt-safe target URL.
 *
 * @param values - Exact browser targets extracted outside the model loop.
 * @returns Canonical hostname used only to rank repository search results.
 */
export function reportedDomainFromAllowedTargets(values: readonly string[]): string | undefined {
    for (const value of values) {
        const canonical = canonicalTargetUrl(value);
        if (canonical) {
            return new URL(canonical).hostname.toLowerCase().replace(/\.$/u, '');
        }
    }
    return undefined;
}

/**
 * Normalize a placement hostname for conservative issue-domain equality.
 *
 * @param value - Candidate bare hostname.
 * @returns Lowercase hostname without a leading `www.` or root dot, or undefined when invalid.
 */
export function normalizePlacementDomain(value: string): string | undefined {
    const normalized = value.trim().toLowerCase().replace(/\.$/u, '');
    if (normalized.length === 0) {
        return undefined;
    }
    try {
        const parsed = new URL(`https://${normalized}`);
        if (
            parsed.username.length > 0 ||
            parsed.password.length > 0 ||
            parsed.port.length > 0 ||
            parsed.pathname !== '/' ||
            parsed.search.length > 0 ||
            parsed.hash.length > 0 ||
            parsed.hostname !== normalized
        ) {
            return undefined;
        }
        return parsed.hostname.replace(/^www\./u, '').replace(/\.$/u, '');
    } catch {
        return undefined;
    }
}

/**
 * Compare model-carried placement fields with the exact deterministic resolver result.
 *
 * @param actual - Placement copied into the model's terminal proposal.
 * @param expected - Most recent applicable resolver result.
 * @returns Whether every typed placement field matches exactly.
 */
export function placementMatches(
    actual: DraftRulePlacement,
    expected: PlacementResolution,
): boolean {
    return (
        actual.filter === expected.filter &&
        actual.filePath === expected.filePath &&
        actual.confidence === expected.confidence &&
        actual.alternatives.length === expected.alternatives.length &&
        actual.alternatives.every(
            (alternative, index) => alternative === expected.alternatives[index],
        )
    );
}

/**
 * Bounded validation bookkeeping retained for one canonical candidate across browser executions.
 */
export interface CandidateValidationOutcome {
    /**
     * One-based runtime candidate attempt number.
     */
    attemptNumber: number;

    /**
     * Vision verdict returned by the attempt, when available.
     */
    visualVerdict?: string;

    /**
     * Bounded vision rationale used only to distinguish technical unavailability from a verdict.
     */
    visualRationale?: string;

    /**
     * Latest runner-owned validation artifact emitted for this canonical candidate.
     */
    validationArtifactId?: string;

    /**
     * Number of browser-bound executions of this semantic candidate.
     */
    validationAttemptCount: number;
}

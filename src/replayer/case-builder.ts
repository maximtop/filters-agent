import type { Octokit } from '@octokit/rest';
import { type GithubReadConfig } from '../github/fetch-issue';
import { IssueState } from '../types/issue-state';
import { ClosureType, type ReplayCase } from '../types/replay';

/**
 * A candidate fixing PR found via search, with metadata for verification.
 */
interface FixingPrCandidate {
    /**
     * The PR number.
     */
    number: number;

    /**
     * ISO timestamp of when the PR was merged.
     */
    mergedAt: string;
}

/**
 * A single file changed in a fixing PR.
 */
interface FixingPrFile {
    /**
     * The file path relative to the repo root.
     */
    filename: string;

    /**
     * The change status (modified, added, removed, etc.).
     */
    status: string;

    /**
     * The unified diff patch, if available.
     */
    patch?: string;
}

/**
 * A verified fixing PR with full details for case construction.
 */
interface FixingPrInfo {
    /**
     * The PR number.
     */
    number: number;

    /**
     * The base commit SHA the PR was opened against.
     */
    baseCommit: string;

    /**
     * The files changed by the PR.
     */
    files: FixingPrFile[];
}

/**
 * Search for merged PRs referencing "Closes #N" and return candidate matches.
 *
 * Retrieves up to 10 search results. Returns candidates with merge timestamps for downstream
 * verification.
 *
 * @param config - GitHub read credentials.
 * @param issueNumber - The closed issue number.
 * @param octokit - An authenticated Octokit instance.
 * @returns Candidate fixing PRs, sorted by merge time descending (most recent first).
 */
async function searchFixingPrCandidates(
    config: GithubReadConfig,
    issueNumber: number,
    octokit: Octokit,
): Promise<FixingPrCandidate[]> {
    const q = `repo:${config.owner}/${config.repo} type:pr is:merged "Closes #${issueNumber}"`;
    const searchRes = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 10 });
    const candidates: FixingPrCandidate[] = [];
    for (const item of searchRes.data.items) {
        const prData = item as Record<string, unknown>;
        const pullRequest = prData.pull_request as SearchResultPullRequest | undefined;
        if (pullRequest?.merged_at) {
            candidates.push({
                number: item.number,
                mergedAt: pullRequest.merged_at,
            });
        }
    }
    candidates.sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime());
    return candidates;
}

/**
 * Find the PR that fixed a closed issue.
 *
 * When multiple PRs match "Closes #N", selects the one merged closest to (and before or at) the
 * issue's `closed_at` timestamp. This avoids picking a later PR that merely references the
 * already-closed issue (Finding 6).
 *
 * @param config - GitHub read credentials.
 * @param issueNumber - The closed issue number.
 * @param octokit - An authenticated Octokit instance.
 * @param issueClosedAt - The ISO timestamp of issue closure.
 * @returns The fixing PR info, or null if none found.
 */
async function findFixingPr(
    config: GithubReadConfig,
    issueNumber: number,
    octokit: Octokit,
    issueClosedAt: string,
): Promise<FixingPrInfo | null> {
    const candidates = await searchFixingPrCandidates(config, issueNumber, octokit);
    if (candidates.length === 0) {
        return null;
    }

    const closedAtMs = new Date(issueClosedAt).getTime();

    // Pick the PR merged at or before issue closed_at, closest in time.
    // If multiple candidates exist, the one merged most recently before closed_at wins.
    let best: FixingPrCandidate | null = null;
    for (const candidate of candidates) {
        const mergedAtMs = new Date(candidate.mergedAt).getTime();
        if (mergedAtMs <= closedAtMs) {
            best = candidate;
            break; // candidates sorted by mergedAt desc, first match is closest
        }
    }
    // Fallback: if no PR was merged before closed_at, pick the most recently merged PR.
    if (!best) {
        best = candidates[0];
    }

    const prRes = await octokit.rest.pulls.get({
        owner: config.owner,
        repo: config.repo,
        pull_number: best.number,
    });
    const filesRes = await octokit.rest.pulls.listFiles({
        owner: config.owner,
        repo: config.repo,
        pull_number: best.number,
    });

    return {
        number: best.number,
        baseCommit: prRes.data.base.sha,
        files: filesRes.data.map((f) => ({
            filename: f.filename,
            status: f.status,
            patch: f.patch,
        })),
    };
}

/**
 * Extract added filter rule lines from a unified diff patch.
 *
 * Only lines starting with `+` (added) that look like filter rules are returned. Explicitly
 * excludes preprocessor directives (`!#include`, `!#if`, `!#endif`, etc.) which are not filter
 * rules (Finding 7).
 *
 * @param patch - The unified diff patch string from GitHub.
 * @returns The extracted rule lines (without the leading `+`).
 */
function extractRulesFromPatch(patch: string): string[] {
    const rules: string[] = [];
    for (const line of patch.split('\n')) {
        if (!line.startsWith('+') || line.startsWith('+++')) {
            continue;
        }
        const rule = line.slice(1).trim();
        if (rule.length === 0) {
            continue;
        }
        // Exclude comments and preprocessor directives
        if (rule.startsWith('!')) {
            const isPreprocessor =
                rule.startsWith('!#include') ||
                rule.startsWith('!#if') ||
                rule.startsWith('!#else') ||
                rule.startsWith('!#endif') ||
                rule.startsWith('!#safari_cb_affinity') ||
                rule.startsWith('!#define');
            if (isPreprocessor) {
                continue;
            }
            // Other `! ...` lines are comments — skip them too
            continue;
        }
        rules.push(rule);
    }
    return rules;
}

/**
 * Determine the closure type from the issue labels and its fixing PR status.
 *
 * @param labels - Issue labels.
 * @param fixingPr - The fixing PR info, if found.
 * @returns The closure type.
 */
function classifyClosure(
    labels: string[],
    fixingPr: FixingPrInfo | null,
): ReplayCase['closureType'] {
    if (fixingPr) {
        const hasRuleChanges = fixingPr.files.some(
            (f) => f.filename.endsWith('.txt') && f.status !== 'removed',
        );
        if (hasRuleChanges) {
            return ClosureType.MergedFix;
        }
    }
    const labelSet = labels.map((l) => l.toLowerCase());
    if (labelSet.some((l) => l.includes('wontfix'))) {
        return ClosureType.Wontfix;
    }
    if (labelSet.some((l) => l.includes('duplicate'))) {
        return ClosureType.Duplicate;
    }
    return ClosureType.CannotReproduce;
}

/**
 * Build a {@link ReplayCase} from a closed GitHub issue.
 *
 * Fetches the issue, searches for the fixing PR (merged PR referencing the issue via "Closes #N"),
 * verifies the correct PR when multiple match (Finding 6), extracts the base commit and gold rules
 * from the PR diff (excluding preprocessor directives per Finding 7), and classifies the closure
 * type.
 *
 * For non-merged-fix cases, `baseCommit` is `undefined` — the replay runner must skip checkout
 * pinning (Finding 1).
 *
 * @param config - GitHub read credentials.
 * @param issueNumber - The closed issue number to build a case for.
 * @param octokit - An authenticated Octokit instance (injectable for tests).
 * @returns The validated replay case.
 * @throws If the issue is not closed or cannot be found.
 */
export async function buildReplayCase(
    config: GithubReadConfig,
    issueNumber: number,
    octokit: Octokit,
): Promise<ReplayCase> {
    const issueRes = await octokit.rest.issues.get({
        owner: config.owner,
        repo: config.repo,
        issue_number: issueNumber,
    });
    const issue = issueRes.data;

    if (issue.state !== IssueState.Closed) {
        throw new Error(`Issue #${issueNumber} is not closed (state: ${issue.state})`);
    }

    const closedAtIso = issue.closed_at
        ? new Date(issue.closed_at).toISOString()
        : new Date().toISOString();

    const labels: string[] = (issue.labels || []).map((l: string | IssueLabel) =>
        typeof l === 'string' ? l : l.name || '',
    );

    const fixingPr = await findFixingPr(config, issueNumber, octokit, closedAtIso);
    const closureType = classifyClosure(labels, fixingPr);

    const goldRules: string[] = [];
    let goldPlacement: string | undefined;

    if (fixingPr) {
        for (const file of fixingPr.files) {
            if (!file.filename.endsWith('.txt')) {
                continue;
            }
            if (file.patch) {
                const rules = extractRulesFromPatch(file.patch);
                if (rules.length > 0 && !goldPlacement) {
                    goldPlacement = file.filename;
                }
                goldRules.push(...rules);
            }
        }
    }

    let goldOutcome: string;
    switch (closureType) {
        case ClosureType.MergedFix:
            goldOutcome = 'fixed';
            break;
        case ClosureType.CannotReproduce:
            goldOutcome = 'cannot-reproduce';
            break;
        case ClosureType.Wontfix:
            goldOutcome = 'wontfix';
            break;
        case ClosureType.Duplicate:
            goldOutcome = 'duplicate';
            break;
        default:
            goldOutcome = 'unknown';
    }

    return {
        issueNumber,
        closureType,
        fixingPr: fixingPr?.number,
        baseCommit: fixingPr?.baseCommit,
        goldRules,
        goldPlacement,
        goldOutcome,
        closedAt: closedAtIso,
    };
}

/**
 * Shape of the pull_request field in a search result item.
 */
interface SearchResultPullRequest {
    /**
     * When the PR was merged, as an ISO timestamp string.
     */
    merged_at?: string;
}

/**
 * A GitHub issue label, which can be a plain string or a label object.
 */
interface IssueLabel {
    /**
     * The label name.
     */
    name?: string;
}

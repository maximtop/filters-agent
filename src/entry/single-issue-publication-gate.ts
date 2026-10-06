/**
 * The two checks that keep a per-issue run from posting a report nobody needs.
 *
 * Before the run pays for intake and investigation: a report for this issue revision already
 * posted, or an issue the publication guard silences (closed, a fix referenced, a maintainer on
 * it), ends the run as a skip. Right before posting: the guard runs again, since a maintainer can
 * act during the run. Both read only GitHub; neither writes.
 */

import type { Octokit } from '@octokit/rest';
import { readIssuePublicationFacts } from '../github/issue-publication-facts';
import type { Logger } from '../logger/logger';
import {
    decidePublication,
    type PublicationDecision,
    type PublicationGuardPolicy,
} from '../publisher/publication-guard';
import {
    findRevisionReport,
    publishReportOnce,
    type ReportPublishInput,
    type ReportPublishResult,
} from '../publisher/report-publisher';
import { TRUSTED_ROLE_VALUES, type TrustedRole } from '../queue/queue-inputs';
import type { RepositorySlug } from '../types/repository-slug';

/**
 * Build the guard policy for the repository the run reports to.
 *
 * The repository's own maintainers are the run's trusted roles; no in-progress label is assumed,
 * since that convention differs from one repository to the next. The run's own reports never count
 * as a maintainer's comment, even when they post from a maintainer's token.
 *
 * @param slug - Repository the run reports to.
 * @param trustedRoles - The run's trusted roles, or undefined for the default set.
 * @param reportAuthorLogin - The GitHub login the run's reports post as.
 * @returns The guard policy.
 */
export function publicationGuardPolicy(
    slug: RepositorySlug,
    trustedRoles: readonly TrustedRole[] | undefined,
    reportAuthorLogin: string,
): PublicationGuardPolicy {
    return {
        repository: `${slug.owner}/${slug.repo}`,
        trustedRoles: trustedRoles ?? TRUSTED_ROLE_VALUES,
        inProgressLabels: [],
        ignoredAuthors: [reportAuthorLogin],
    };
}

/**
 * Read the issue and decide whether the guard silences a report on it.
 *
 * @param client - Authenticated GitHub API client.
 * @param slug - Repository the run reports to.
 * @param issueNumber - Issue the run reports on.
 * @param policy - Guard policy for the repository.
 * @returns The decision with its reason, or null when nothing stands in the way.
 */
async function readSilence(
    client: Octokit,
    slug: RepositorySlug,
    issueNumber: number,
    policy: PublicationGuardPolicy,
): Promise<PublicationDecision | null> {
    const facts = await readIssuePublicationFacts(client, {
        owner: slug.owner,
        repo: slug.repo,
        issueNumber,
    });
    const decision = decidePublication(facts, policy);
    return decision.reason === null ? null : decision;
}

/**
 * Why a run stops before it pays for anything.
 */
export interface PreRunSkip {
    /**
     * Human reason for the skip.
     */
    reason: string;

    /**
     * The prior report when one already covers this revision, otherwise null.
     */
    publication: ReportPublishResult | null;
}

/**
 * Inputs of the pre-run check.
 */
export interface PreRunCheckInput {
    /**
     * Repository the run reports to.
     */
    slug: RepositorySlug;

    /**
     * Issue the run reports on.
     */
    issueNumber: number;

    /**
     * Digest of the issue revision the run would report.
     */
    revisionDigest: string;

    /**
     * The GitHub login authoritative for the run's own report markers.
     */
    reportAuthorLogin: string;

    /**
     * The run's trusted roles, or undefined for the default set.
     */
    trustedRoles: readonly TrustedRole[] | undefined;
}

/**
 * Decide whether a run should stop before intake extraction.
 *
 * @param client - Authenticated GitHub API client.
 * @param input - Issue, revision, the run's identity and trusted roles.
 * @param logger - Run logger; the guard's signals are logged when it silences.
 * @returns The skip, or null when the run should go on.
 */
export async function checkIssueBeforeRun(
    client: Octokit,
    input: PreRunCheckInput,
    logger: Logger,
): Promise<PreRunSkip | null> {
    const reported = await findRevisionReport(client, {
        owner: input.slug.owner,
        repo: input.slug.repo,
        issueNumber: input.issueNumber,
        revisionDigest: input.revisionDigest,
        reportAuthorLogin: input.reportAuthorLogin,
    });
    if (reported !== null) {
        return {
            reason: 'A report for this issue revision is already posted.',
            publication: reported,
        };
    }
    const policy = publicationGuardPolicy(input.slug, input.trustedRoles, input.reportAuthorLogin);
    const silence = await readSilence(client, input.slug, input.issueNumber, policy);
    if (silence !== null) {
        logger.info(
            { issueNumber: input.issueNumber, reason: silence.reason, signals: silence.signals },
            'the publication guard skips the run',
        );
        return {
            reason: `The issue needs no report: ${silence.signals.join('; ')}.`,
            publication: null,
        };
    }
    return null;
}

/**
 * Post the report unless the guard silences it now.
 *
 * @param client - Authenticated GitHub API client.
 * @param input - The report publication.
 * @param trustedRoles - The run's trusted roles, or undefined for the default set.
 * @param logger - Run logger; the guard's signals are logged when it silences.
 * @returns The publication, or null when the guard kept the report silent.
 */
export async function publishGuardedReport(
    client: Octokit,
    input: ReportPublishInput,
    trustedRoles: readonly TrustedRole[] | undefined,
    logger: Logger,
): Promise<ReportPublishResult | null> {
    const slug = { owner: input.owner, repo: input.repo };
    const policy = publicationGuardPolicy(slug, trustedRoles, input.reportAuthorLogin);
    const silence = await readSilence(client, slug, input.issueNumber, policy);
    if (silence !== null) {
        logger.info(
            { issueNumber: input.issueNumber, reason: silence.reason, signals: silence.signals },
            'the publication guard keeps the report silent',
        );
        return null;
    }
    return publishReportOnce(client, input);
}

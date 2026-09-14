/**
 * Best-effort short-report posting for a sealed outcome that never reached a locked `FixRunResult`
 * — a skip, or a failure once the run's revision digest was already computed.
 *
 * Backlog selection's dedupe and revision budget only see a comment's marker; without one, a
 * repeatedly skipped or failing issue is retaken on every run, paying for a new attempt each time.
 * Posting here closes that gap the same way a fully processed run's report does. Also carries the
 * shared "log the caught error in full before mapping or swallowing it" helper every catch in the
 * default single-issue engine uses.
 */

import { createOctokit } from '../github/fetch-issue';
import { resolveReportAuthorLogin } from '../github/report-author-identity';
import type { Logger } from '../logger/logger';
import {
    buildReportTemplateValues,
    renderReportComment,
    type ReportOutcomeSummary,
} from '../publisher/report-render';
import { publishReportOnce, type ReportPublishResult } from '../publisher/report-publisher';
import { resolveReportTemplate } from '../publisher/report-template';
import type {
    DefaultSingleIssueDependencies,
    DefaultSingleIssueRequest,
} from './single-issue-run-types';

/**
 * Log one caught error in full — message, stack, and cause — before it is mapped to a typed failure
 * or otherwise swallowed, so the underlying detail is never lost to a bare code.
 *
 * @param logger - Diagnostics sink.
 * @param phase - What the run was doing when the error was caught.
 * @param error - The caught error.
 * @param context - Extra structured fields logged beside the error (e.g. the issue number).
 */
export function logCaughtError(
    logger: Logger,
    phase: string,
    error: unknown,
    context: Record<string, unknown> = {},
): void {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ ...context, err }, `${phase} failed`);
}

/**
 * The rendered body and publication outcome of one minimal-outcome report attempt.
 */
export interface MinimalOutcomeReport {
    /**
     * The exact rendered Markdown body, minus the hidden revision marker.
     */
    body: string;

    /**
     * The publication action and identity, or null when comments are disabled or the best-effort
     * publish attempt itself failed.
     */
    publication: ReportPublishResult | null;
}

/**
 * Render, and when comments are enabled attempt to post, the minimal short report for an outcome
 * that has no locked run result.
 *
 * Never throws: a publication failure here is logged and a null publication is returned, since this
 * best-effort comment is not the run's own purpose — the caller already has its own seal (the skip,
 * or the failure it is separately reporting).
 *
 * @param request - The per-issue request.
 * @param logger - Diagnostics sink.
 * @param revisionDigest - The computed revision identity to bind the marker to.
 * @param instructionContent - Loaded run instruction content, for the report template.
 * @param outcomeLabel - Human outcome line (e.g. "Issue skipped", "Intake extraction failed").
 * @param outcomeReason - Detail explaining the outcome.
 * @param dependencies - Injectable seams; only the prebuilt GitHub client is read.
 * @returns The rendered report body and the publication result, or a null publication when comments
 *   are disabled or the best-effort publish attempt itself failed.
 */
export async function postMinimalOutcomeReport(
    request: DefaultSingleIssueRequest,
    logger: Logger,
    revisionDigest: string,
    instructionContent: string | undefined,
    outcomeLabel: string,
    outcomeReason: string,
    dependencies: Pick<DefaultSingleIssueDependencies, 'octokit'>,
): Promise<MinimalOutcomeReport> {
    const template = resolveReportTemplate(instructionContent).template;
    const summary: ReportOutcomeSummary = {
        outcome: outcomeLabel,
        outcomeReason,
        versionUpdateHint: '',
        symptom: '',
        rule: '',
        listPlace: '',
        executor: '',
        executorVersion: '',
        policyRationale: '',
        missingInformation: [],
        artifactsLink: request.actionsRunUrl ?? '',
    };
    const body = renderReportComment(template, buildReportTemplateValues(summary));
    if (!request.commentsEnabled || request.slug === null) {
        return { body, publication: null };
    }
    const slug = request.slug;
    try {
        const client =
            dependencies.octokit ??
            createOctokit({ owner: slug.owner, repo: slug.repo, token: request.token ?? '' });
        const reportAuthorLogin = await resolveReportAuthorLogin(client, logger);
        const publication = await publishReportOnce(client, {
            owner: slug.owner,
            repo: slug.repo,
            issueNumber: request.issueNumber,
            revisionDigest,
            reportAuthorLogin,
            body,
        });
        return { body, publication };
    } catch (error) {
        logCaughtError(logger, 'minimal outcome report publication', error, {
            issueNumber: request.issueNumber,
        });
        return { body, publication: null };
    }
}

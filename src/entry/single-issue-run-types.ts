/**
 * Request, outcome, and seam vocabulary of the default single-issue engine. The engine in
 * `single-issue-run.ts` consumes exactly these, so the contract reads in one leaf and no caller has
 * to import the executor for a type.
 */

import type { Octokit } from '@octokit/rest';
import type { CoreConfig } from '../config/config';
import type { FetchIssueOptions, GithubReadConfig, RawIssue } from '../github/fetch-issue';
import type { extractReport } from '../intake/extract-report';
import type { FiltersPreparationDependencies } from '../local/filters-preparer';
import type { VerifiedIssueRevision } from '../local/issue-revision';
import type { Logger } from '../logger/logger';
import type { ReportPublishResult } from '../publisher/report-publisher';
import type { TrustedRole } from '../queue/queue-inputs';
import type { RepositorySlug } from '../types/repository-slug';
import type {
    FixCoreDependencies,
    FixCoreIssueInput,
    FixCoreOptions,
} from '../orchestrator/fix-core-inputs';
import type { AgentRunArtifacts } from '../types/agent-run-artifacts';
import type { FixRunResult } from '../types/fix-run-result';

/**
 * How a per-issue run sealed.
 */
export const DefaultSingleIssueResultKind = {
    /**
     * The investigation sealed; the result carries the locked run record.
     */
    Processed: 'processed',

    /**
     * The issue is not a filter report; intake extraction skipped it. A skip is a successful
     * outcome — it exits zero and, when comments are enabled, still posts the short report so
     * backlog selection gains a durable marker and never retakes the issue for this revision.
     */
    Skipped: 'skipped',

    /**
     * A prerequisite or the run's whole purpose failed; the result names the stage and the detail.
     */
    Failed: 'failed',
} as const;

/**
 * Every DefaultSingleIssueResultKind value, for exhaustive listings.
 */
export const DEFAULT_SINGLE_ISSUE_RESULT_KIND_VALUES = Object.values(DefaultSingleIssueResultKind);

/**
 * DefaultSingleIssueResultKind value.
 */
export type DefaultSingleIssueResultKind =
    (typeof DefaultSingleIssueResultKind)[keyof typeof DefaultSingleIssueResultKind];

/**
 * Stable failure stages of the per-issue contract, named in the result instead of mapped from
 * exception strings.
 */
export const DefaultSingleIssueFailure = {
    /**
     * The filters workspace could not be materialized: a repositoryless run names the missing
     * repository, the preparer names its own git failure.
     */
    WorkspaceUnavailable: 'workspace_unavailable',

    /**
     * The run instruction could not be loaded; the loader's message names the path or link.
     */
    InstructionUnavailable: 'instruction_unavailable',

    /**
     * The issue could not be obtained from the snapshot or the fetch seam.
     */
    IssueUnavailable: 'issue_unavailable',

    /**
     * The investigation itself failed — the run's whole purpose failed.
     */
    InvestigationFailed: 'investigation_failed',

    /**
     * The report publication failed; the platform failure traveled here, unswallowed but typed.
     */
    PublicationFailed: 'publication_failed',

    /**
     * The run instruction declares a file-backed verification method: no session in this run writes
     * the file the host would read back, so the phase could never verify. Refused before the issue
     * is fetched or intake extraction runs.
     */
    FileBackedApplicationUnsupported: 'file_backed_application_unsupported',
} as const;

/**
 * Every DefaultSingleIssueFailure value, for exhaustive listings.
 */
export const DEFAULT_SINGLE_ISSUE_FAILURE_VALUES = Object.values(DefaultSingleIssueFailure);

/**
 * DefaultSingleIssueFailure value.
 */
export type DefaultSingleIssueFailure =
    (typeof DefaultSingleIssueFailure)[keyof typeof DefaultSingleIssueFailure];

/**
 * The issue, its workspace source, and the posting policy one per-issue run threads.
 */
export interface DefaultSingleIssueRequest {
    /**
     * Validated LLM and browser configuration the run investigates under.
     */
    config: CoreConfig;

    /**
     * Resolved repository identity; nullable only for a snapshot-sourced issue.
     */
    slug: RepositorySlug | null;

    /**
     * Local checkout the run shares objects from, when one exists.
     */
    checkoutPath?: string | undefined;

    /**
     * Issue number the run processes.
     */
    issueNumber: number;

    /**
     * Exported issue snapshot path; a snapshot-sourced issue needs no GitHub read.
     */
    issueSnapshotPath?: string | undefined;

    /**
     * GitHub token serving reads and report comments.
     */
    token?: string | undefined;

    /**
     * Whether report comments are posted for this run.
     */
    commentsEnabled: boolean;

    /**
     * Reasoning-model override.
     */
    model?: string | undefined;

    /**
     * Executor names this run locks; absent locks every registered executor.
     */
    executors?: readonly string[] | undefined;

    /**
     * Run instruction path overriding the checkout default probe.
     */
    instructionPath?: string | undefined;

    /**
     * Directory every trace and browser artifact is written to.
     */
    artifactsDir: string;

    /**
     * The GitHub Actions run URL serving as the report's artifacts link; absent when the run has no
     * runner variables (the CLI), in which case the report carries no artifacts link.
     */
    actionsRunUrl?: string | undefined;

    /**
     * The resolved trusted-association set threaded into the issue fetch and intake extraction, so
     * both stages — and the revision digest computed over the fetch's own comments — agree with
     * whatever policy backlog selection counted a new revision under. Absent falls back to
     * `DEFAULT_TRUSTED_ROLES` at the fetch and extraction seams.
     */
    trustedRoles?: readonly TrustedRole[] | undefined;
}

/**
 * Injectable seams of the per-issue engine; production passes nothing and gets the real reader,
 * fetcher, preparer, investigator, publisher, and intake extractor (composed through the shared
 * module in `intake-extraction.ts`).
 */
export interface DefaultSingleIssueDependencies {
    /**
     * Exported-snapshot reader; production verifies the bundle from disk.
     */
    loadIssueRevision?: (issueSnapshotPath: string) => VerifiedIssueRevision;

    /**
     * GitHub fetch seam; production reads the named issue through Octokit, bounded by the shared
     * automatic-upstream prompt text limits.
     */
    fetchIssue?: (
        config: GithubReadConfig,
        issueNumber: number,
        options?: FetchIssueOptions,
    ) => Promise<RawIssue>;

    /**
     * Command and filesystem seams for the filters preparer; tests script the git flow here.
     */
    preparationDependencies?: FiltersPreparationDependencies | undefined;

    /**
     * Investigation seam; production investigates through runFixCore.
     */
    investigate?: (
        config: CoreConfig,
        issue: FixCoreIssueInput,
        options: FixCoreOptions,
        coreDependencies: FixCoreDependencies,
    ) => Promise<FixRunResult>;

    /**
     * Prebuilt GitHub client for the report publication; production builds one from the token.
     */
    octokit?: Octokit | undefined;

    /**
     * Diagnostics sink the intake extraction, its diagnosis records, and the run's own failure
     * notes use; production builds one, tests inject a counting fake.
     */
    logger?: Logger;

    /**
     * Intake extraction seam — the one required dependency: production composes the real extractor
     * through the shared `intake-extraction` module, and every hermetic fixture must inject its own
     * (omission is a compile error), so no fixture can reach the real provider.
     */
    extractReport: typeof extractReport;
}

/**
 * One per-issue run that investigated and sealed.
 */
export interface ProcessedDefaultSingleIssue {
    /**
     * How the run sealed.
     */
    kind: typeof DefaultSingleIssueResultKind.Processed;

    /**
     * Issue the run processed.
     */
    issueNumber: number;

    /**
     * The locked investigation record.
     */
    runResult: FixRunResult;

    /**
     * The report publication action and identity, or null when posting was skipped.
     */
    publication: ReportPublishResult | null;

    /**
     * Directory the investigation's retained artifacts landed in; consumers derive the report and
     * patch print paths from it.
     */
    artifactsDir: string;
}

/**
 * One per-issue run that skipped: intake extraction decided the issue is not a filter report. A
 * successful outcome — the caller exits zero — that still carries the reason both for the run log
 * and for the report artifact/comment.
 */
export interface SkippedDefaultSingleIssue {
    /**
     * How the run sealed.
     */
    kind: typeof DefaultSingleIssueResultKind.Skipped;

    /**
     * Issue the run skipped.
     */
    issueNumber: number;

    /**
     * Why the issue is not a filter report.
     */
    reason: string;

    /**
     * The report publication action and identity, or null when posting was skipped.
     */
    publication: ReportPublishResult | null;

    /**
     * Directory the run's artifacts landed in.
     */
    artifactsDir: string;
}

/**
 * One per-issue run that failed, naming its stage and the underlying detail.
 */
export interface FailedDefaultSingleIssue {
    /**
     * How the run sealed.
     */
    kind: typeof DefaultSingleIssueResultKind.Failed;

    /**
     * Issue the run was asked to process.
     */
    issueNumber: number;

    /**
     * The stable failure stage.
     */
    failureCode: DefaultSingleIssueFailure;

    /**
     * The underlying detail kept for diagnosis, never mapped to a bare code.
     */
    failureDetail: string;
}

/**
 * Investigation artifacts collected through the core side channel; holder-typed so callback writes
 * stay visible to reads that follow the investigation.
 */
export interface CollectedAgentArtifacts {
    /**
     * The model-owned terminal decision and its observations, or null while the loop delivered
     * none.
     */
    artifacts: AgentRunArtifacts | null;
}

/**
 * The typed seal of one per-issue run.
 */
export type DefaultSingleIssueResult =
    | ProcessedDefaultSingleIssue
    | SkippedDefaultSingleIssue
    | FailedDefaultSingleIssue;

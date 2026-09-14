import * as v from 'valibot';

/**
 * Canonical problem-type vocabulary shared by the parser, intake scope, and agent tool schemas.
 */
export const PROBLEM_TYPE_VALUES = [
    'ads',
    'anti-adblock',
    'annoyance',
    'incorrect-blocking',
    'unknown',
] as const;

export const ProblemTypeSchema = v.picklist(PROBLEM_TYPE_VALUES);
export type ProblemType = v.InferOutput<typeof ProblemTypeSchema>;

/**
 * Named problem types, so behaviour that branches on a report class never spells one inline.
 */
export const ProblemType = {
    Ads: 'ads',
    AntiAdblock: 'anti-adblock',
    Annoyance: 'annoyance',
    IncorrectBlocking: 'incorrect-blocking',
    Unknown: 'unknown',
} as const satisfies Record<string, ProblemType>;

/**
 * Whether a report describes filtering breaking a site rather than failing to block ads.
 *
 * The whole incorrect-blocking path — exception candidates, breakage rubrics, the fix workflow in
 * the system prompt — turns on this single question, so it is asked in one place.
 *
 * @param problemType - Parsed problem type of the report, when known.
 * @returns True for an incorrect-blocking (false positive) report.
 */
export function isIncorrectBlockingReport(problemType?: ProblemType): boolean {
    return problemType === ProblemType.IncorrectBlocking;
}

export const IssueScreenshotSchema = v.object({
    url: v.pipe(v.string(), v.url()),
    description: v.optional(v.string()),
});

export type IssueScreenshot = v.InferOutput<typeof IssueScreenshotSchema>;

export const IssueFactsSchema = v.object({
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    issueUrl: v.pipe(v.string(), v.url()),
    reportedSiteUrls: v.array(v.pipe(v.string(), v.url())),
    labels: v.array(v.string()),
    declaredIssueType: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
    problemType: ProblemTypeSchema,
    product: v.string(),
    os: v.optional(v.string()),
    browser: v.optional(v.string()),
    enabledFilters: v.array(v.string()),
    settingsImportUrl: v.optional(v.pipe(v.string(), v.url())),
    userComment: v.optional(v.string()),
    screenshots: v.array(IssueScreenshotSchema),
    reproductionSteps: v.optional(v.array(v.string())),
});

export type IssueFacts = v.InferOutput<typeof IssueFactsSchema>;

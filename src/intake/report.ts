import * as v from 'valibot';

/**
 * Problem-type vocabulary of the model-filled report, per the PRD's Report entity.
 *
 * Deliberately separate from the shared `ProblemType` (issue-facts): the report vocabulary uses
 * `other` where the facts vocabulary uses `unknown`, and the mapping between the two lives in
 * `report-facts.ts`.
 */
export const ReportProblemType = {
    /**
     * The report is about ads that are not blocked.
     */
    Ads: 'ads',

    /**
     * The report is about an anti-adblock wall or script.
     */
    AntiAdblock: 'anti-adblock',

    /**
     * The report is about filtering that breaks the page.
     */
    IncorrectBlocking: 'incorrect-blocking',

    /**
     * The report is about an annoyance, not ads.
     */
    Annoyance: 'annoyance',

    /**
     * The report carries no recognizable problem class.
     */
    Other: 'other',
} as const;

/**
 * ReportProblemType value.
 */
export type ReportProblemType = (typeof ReportProblemType)[keyof typeof ReportProblemType];

/**
 * Every report problem type, for the picklist schema.
 */
export const REPORT_PROBLEM_TYPE_VALUES = Object.values(ReportProblemType);

/**
 * Extraction verdicts of the intake envelope: whether the issue is a filter report at all.
 */
export const IntakeVerdict = {
    /**
     * The issue is a filter report; the payload carries the filled report.
     */
    FilterReport: 'filter-report',

    /**
     * The issue is not a filter report; the payload carries the reason.
     */
    NotAFilterReport: 'not-a-filter-report',
} as const;

/**
 * IntakeVerdict value.
 */
export type IntakeVerdict = (typeof IntakeVerdict)[keyof typeof IntakeVerdict];

/**
 * One reporter screenshot reference carried by the report.
 */
export const ReportScreenshotSchema = v.object({
    /**
     * The screenshot's image URL.
     */
    url: v.pipe(v.string(), v.url()),

    /**
     * The reporter's caption, when one exists.
     */
    description: v.optional(v.string()),
});

/**
 * A reporter screenshot reference.
 */
export type ReportScreenshot = v.InferOutput<typeof ReportScreenshotSchema>;

/**
 * The reporter's environment as the report declares it, copied verbatim.
 */
export const ReportEnvironmentSchema = v.object({
    /**
     * The product name, verbatim including any version or MV markers.
     */
    product: v.optional(v.string()),

    /**
     * The browser name, verbatim.
     */
    browser: v.optional(v.string()),

    /**
     * The operating system, verbatim.
     */
    os: v.optional(v.string()),

    /**
     * The product version, verbatim.
     */
    version: v.optional(v.string()),
});

/**
 * The reporter's declared environment.
 */
export type ReportEnvironment = v.InferOutput<typeof ReportEnvironmentSchema>;

/**
 * The model-filled, code-validated report extracted from one issue.
 *
 * `siteUrls` is mandatory with at least one entry: an issue without a site URL is the skip variant
 * of the extraction envelope, never an empty-array report.
 */
export const ReportSchema = v.object({
    /**
     * Target URLs from the issue; at least one is required for a filter report.
     */
    siteUrls: v.pipe(v.array(v.pipe(v.string(), v.url())), v.minLength(1)),

    /**
     * The report's problem class.
     */
    problemType: v.picklist(REPORT_PROBLEM_TYPE_VALUES),

    /**
     * The form-declared type (the bot template's `### Issue URL (…)` parenthetical), copied
     * verbatim; bounded by the same 100-character ceiling the facts schema enforces.
     */
    declaredType: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),

    /**
     * The reporter's description of the problem.
     */
    comment: v.optional(v.string()),

    /**
     * Reporter screenshot references; the prompt caps the count, the schema does not.
     */
    screenshots: v.array(ReportScreenshotSchema),

    /**
     * The reporter's environment, copied verbatim.
     */
    environment: ReportEnvironmentSchema,

    /**
     * Enabled filter lists, including the lists named by the settings-import link.
     */
    enabledLists: v.array(v.string()),

    /**
     * The settings-import link the run seeds the blocker from, when the issue carries one.
     */
    settingsImportUrl: v.optional(v.pipe(v.string(), v.url())),

    /**
     * The reporter's custom or applied rules.
     */
    userRules: v.array(v.string()),

    /**
     * Per-list blocked counts from a uBO-widget YAML block, when present.
     */
    blockedCounts: v.optional(v.record(v.string(), v.number())),

    /**
     * The reporter's reproduction steps.
     */
    reproductionSteps: v.array(v.string()),
});

/**
 * The model-filled report extracted from one issue.
 */
export type Report = v.InferOutput<typeof ReportSchema>;

/**
 * The extraction envelope payload: a filled report or an explicit skip with a reason.
 *
 * A variant (discriminated union) on `verdict`, not a plain union: a plain union collapses the
 * failing variant's issues into one pathless message, which would break the contract that a
 * validation failure names the field. The variant keeps the nested paths (`report.siteUrls`,
 * `verdict`) in the issue list.
 */
export const IntakeExtractionPayloadSchema = v.variant('verdict', [
    v.object({
        /**
         * Discriminator: the issue is a filter report.
         */
        verdict: v.literal(IntakeVerdict.FilterReport),

        /**
         * The filled report.
         */
        report: ReportSchema,
    }),
    v.object({
        /**
         * Discriminator: the issue is not a filter report.
         */
        verdict: v.literal(IntakeVerdict.NotAFilterReport),

        /**
         * Why the issue is not a filter report.
         */
        reason: v.pipe(v.string(), v.minLength(1)),
    }),
]);

/**
 * The validated extraction payload, ready for verdict dispatch.
 */
export type IntakeExtractionPayload = v.InferOutput<typeof IntakeExtractionPayloadSchema>;

import * as v from 'valibot';

/**
 * Decoupled browser drift signal recorded next to a replay comparison.
 */
export const ReproductionSignal = {
    Reproduced: 'true',
    Drifted: 'false',
    NotAssessed: 'n/a',
} as const;

export const REPRODUCTION_SIGNAL_VALUES = Object.values(ReproductionSignal);

/**
 * One reproduction signal: 'true' still reproduces, 'false' drifted, 'n/a' no browser signal.
 */
export type ReproductionSignal = (typeof ReproductionSignal)[keyof typeof ReproductionSignal];

/**
 * How a replayed GitHub issue was closed upstream.
 */
export const ClosureType = {
    /**
     * The issue was closed by a merged fix.
     */
    MergedFix: 'merged-fix',

    /**
     * The issue was closed as not reproducible.
     */
    CannotReproduce: 'cannot-reproduce',

    /**
     * The issue was closed as won't-fix.
     */
    Wontfix: 'wontfix',

    /**
     * The issue was closed as a duplicate of another issue.
     */
    Duplicate: 'duplicate',
} as const;

/**
 * Every ClosureType value, for schemas and exhaustive listings.
 */
export const CLOSURE_TYPE_VALUES = Object.values(ClosureType);

export const ClosureTypeSchema = v.picklist(CLOSURE_TYPE_VALUES);

/**
 * ClosureType value.
 */
export type ClosureType = (typeof ClosureType)[keyof typeof ClosureType];

export const ReplayCaseSchema = v.object({
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    closureType: ClosureTypeSchema,
    fixingPr: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    baseCommit: v.optional(v.string()),
    goldRules: v.array(v.string()),
    goldPlacement: v.optional(v.string()),
    goldOutcome: v.string(),
    closedAt: v.pipe(v.string(), v.isoTimestamp()),
});

export const RubricSchema = v.object({
    outcomeClassMatch: v.boolean(),
    targetDomainMatch: v.boolean(),
    normalizedRuleEquivalent: v.boolean(),
    filterFileMatch: v.boolean(),
});

export const JudgeVerdictSchema = v.object({
    verdict: v.picklist(['equivalent', 'partial', 'different']),
    rationale: v.string(),
});

export const ReplayComparisonSchema = v.object({
    agentOutcome: v.string(),
    agentRules: v.array(v.string()),
    agentPlacement: v.optional(v.string()),
    rubric: RubricSchema,
    judgeVerdict: JudgeVerdictSchema,
    reproduced: v.picklist(REPRODUCTION_SIGNAL_VALUES),
    mdArtifactPath: v.string(),
});

export type ReplayCase = v.InferOutput<typeof ReplayCaseSchema>;
export type ReplayComparison = v.InferOutput<typeof ReplayComparisonSchema>;

export type Rubric = v.InferOutput<typeof RubricSchema>;
export type JudgeVerdict = v.InferOutput<typeof JudgeVerdictSchema>;

/**
 * Schema of the replay run's terminal verdict payload — the typed replacement for the fenced JSON
 * grading block the legacy replay prompt demanded. The fields are exactly what the replay grader
 * consumes; the outcome vocabulary is the pinned closure classification the verdict is graded
 * against.
 */
export const ReplayVerdictSchema = v.object({
    outcome: ClosureTypeSchema,
    rules: v.array(v.string()),
    placement: v.optional(v.string()),
    reasoning: v.string(),
});

/**
 * The agent's graded replay verdict, submitted through the replay terminal tool.
 */
export type ReplayVerdict = v.InferOutput<typeof ReplayVerdictSchema>;

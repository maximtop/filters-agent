/**
 * The usage-accounting honesty vocabularies, declared once for the whole codebase: how completely a
 * run's provider replies reported usage, how much of it could be priced, and the two campaign-era
 * spellings of the same two questions.
 *
 * Both eras live here TOGETHER rather than merged, and the merge is not available: each spelling is
 * pinned by an artifact already on disk. `costCoverage`/`usageCompleteness` are persisted fields of
 * the v2 run usage summary (`RunUsageSummarySchema`), and `costStatus`/`telemetryHealth` are
 * persisted fields of every campaign artifact — including pre-migration ones, which is also why
 * `CostStatus` keeps the `Reported` and `Mixed` members pi can no longer produce (see
 * `campaign-cost-status.ts`). Renaming either set to the other's literals stops one of the two
 * formats parsing.
 *
 * What the merge would have removed is here instead: the correspondence between the two eras is
 * stated once, as the two tables below, so no consumer re-derives it and no module grows a private
 * mapper whose name collides with a different function of the same name.
 */

/**
 * How completely a run's provider replies reported usages. Persisted as `usageCompleteness` in the
 * v2 run usage summary.
 */
export const UsageCompleteness = {
    /**
     * Every completion reported its token usage.
     */
    Complete: 'complete',

    /**
     * Some completions reported usage and some did not.
     */
    Partial: 'partial',

    /**
     * No completion reported usage.
     */
    Unreported: 'unreported',
} as const;

/**
 * Every UsageCompleteness value, for schemas and exhaustive listings.
 */
export const USAGE_COMPLETENESS_VALUES = Object.values(UsageCompleteness);

/**
 * UsageCompleteness value.
 */
export type UsageCompleteness = (typeof UsageCompleteness)[keyof typeof UsageCompleteness];

/**
 * How much of a run's cost could be priced from the configured rates. Persisted as `costCoverage`
 * in the v2 run usage summary.
 */
export const CostCoverage = {
    /**
     * Every reported completion's model had configured rates.
     */
    Full: 'full',

    /**
     * Some completions were priced, some were not; the total is the priceable part and is labelled
     * as such.
     */
    Partial: 'partial',

    /**
     * Nothing was reported, or nothing reported could be priced.
     */
    None: 'none',
} as const;

/**
 * Every CostCoverage value, for schemas and exhaustive listings.
 */
export const COST_COVERAGE_VALUES = Object.values(CostCoverage);

/**
 * CostCoverage value.
 */
export type CostCoverage = (typeof CostCoverage)[keyof typeof CostCoverage];

/**
 * How trustworthy a run's LLM cost figure is. Persisted as `costStatus` in every campaign artifact.
 */
export const CostStatus = {
    Reported: 'reported',
    Estimated: 'estimated',
    Mixed: 'mixed',
    Partial: 'partial',
    Unavailable: 'unavailable',
} as const;

/**
 * Every CostStatus value, for schemas and exhaustive listings.
 */
export const COST_STATUS_VALUES = Object.values(CostStatus);

/**
 * CostStatus value.
 */
export type CostStatus = (typeof CostStatus)[keyof typeof CostStatus];

/**
 * Whether provider usage telemetry covered every request of a run. Persisted as `telemetryHealth`
 * in every campaign artifact.
 */
export const TelemetryHealth = {
    Healthy: 'healthy',
    NoProviderCalls: 'no_provider_calls',
    Incomplete: 'incomplete',
} as const;

/**
 * Every telemetry health value, for schemas and exhaustive listings.
 */
export const TELEMETRY_HEALTH_VALUES = Object.values(TelemetryHealth);

/**
 * Telemetry health value.
 */
export type TelemetryHealth = (typeof TelemetryHealth)[keyof typeof TelemetryHealth];

/**
 * The campaign cost status each run-era cost coverage denotes.
 *
 * `Full` becomes `Estimated` rather than `Reported`: every pi-era figure is priced from the tracked
 * rate pin, and the provider-reported route that produced `Reported` is gone. This is the whole
 * correspondence — a pi-era campaign case never carries a cost status derived any other way.
 */
export const CAMPAIGN_COST_STATUS_BY_COVERAGE: Readonly<Record<CostCoverage, CostStatus>> = {
    [CostCoverage.Full]: CostStatus.Estimated,
    [CostCoverage.Partial]: CostStatus.Partial,
    [CostCoverage.None]: CostStatus.Unavailable,
};

/**
 * The campaign telemetry health each run-era completeness denotes, for a run that made at least one
 * provider call.
 *
 * Not a rename in either direction: `NoProviderCalls` has no run-era counterpart at all — the
 * completion count answers it, not the completeness — so a caller must settle that case before
 * consulting this table. `Partial` and `Unreported` both land on `Incomplete`, because the campaign
 * vocabulary asks only whether telemetry covered the whole run.
 */
export const CAMPAIGN_TELEMETRY_HEALTH_BY_COMPLETENESS: Readonly<
    Record<UsageCompleteness, TelemetryHealth>
> = {
    [UsageCompleteness.Complete]: TelemetryHealth.Healthy,
    [UsageCompleteness.Partial]: TelemetryHealth.Incomplete,
    [UsageCompleteness.Unreported]: TelemetryHealth.Incomplete,
};

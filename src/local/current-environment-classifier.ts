import { FixRunStatus } from '../types/fix-run-result';

/**
 * Reproduction observation produced by one browser settings profile.
 */
export const SymptomObservation = {
    /**
     * The browser settings profile observed the reported symptom present.
     */
    Reproduced: 'reproduced',

    /**
     * The browser settings profile observed the reported symptom absent.
     */
    NotReproduced: 'not_reproduced',

    /**
     * The observation could not settle whether the symptom was present or absent.
     */
    Partial: 'partial',

    /**
     * This browser settings profile was not run.
     */
    NotRun: 'not_run',
} as const;

/**
 * Every SymptomObservation value, for schemas and exhaustive listings.
 */
export const SYMPTOM_OBSERVATION_VALUES = Object.values(SymptomObservation);

/**
 * SymptomObservation value.
 */
export type SymptomObservation = (typeof SymptomObservation)[keyof typeof SymptomObservation];

/**
 * Browser validation observation for an existing or proposed rule.
 */
export const RuleValidationObservation = {
    /**
     * The rule was verified to behave as intended.
     */
    Passed: 'passed',

    /**
     * The rule was verified and did not behave as intended.
     */
    Failed: 'failed',

    /**
     * Validation could not settle whether the rule passed or failed.
     */
    Partial: 'partial',

    /**
     * Rule validation was not run.
     */
    NotRun: 'not_run',
} as const;

/**
 * Every RuleValidationObservation value, for schemas and exhaustive listings.
 */
export const RULE_VALIDATION_OBSERVATION_VALUES = Object.values(RuleValidationObservation);

/**
 * RuleValidationObservation value.
 */
export type RuleValidationObservation =
    (typeof RuleValidationObservation)[keyof typeof RuleValidationObservation];

/**
 * Complete vision-derived evidence used to classify a current-environment run.
 */
export interface CurrentEnvironmentObservations {
    /**
     * Whether a browser was available for factual reproduction checks.
     */
    browserAvailable: boolean;

    /**
     * Whether the planned browser investigation reached a terminal evidence state.
     */
    analysisComplete: boolean;

    /**
     * Symptom state without AdGuard filtering.
     */
    unfiltered: SymptomObservation;

    /**
     * Symptom state with fresh defaults and the required relevant filter.
     */
    defaultsPlusRequired: SymptomObservation;

    /**
     * Symptom state with the reporter's settings on the current extension.
     */
    reported: SymptomObservation;

    /**
     * Validation state of a newly proposed candidate rule.
     */
    candidate: RuleValidationObservation;

    /**
     * Fatal non-browser failure detail, when the run could not continue.
     */
    fatalError?: string;
}

/**
 * Stable reason codes explaining a current-environment classification.
 */
export const CurrentEnvironmentReason = {
    /**
     * The unfiltered control no longer reproduces the reported symptom.
     */
    SiteDrift: 'site_drift',

    /**
     * Fresh defaults plus the required filter resolve the reported symptom.
     */
    CurrentFiltersFixed: 'current_filters_fixed',

    /**
     * The reporter's settings profile disagrees with the controlled profile.
     */
    ReporterConfigurationConflict: 'reporter_configuration_conflict',

    /**
     * Fresh defaults plus the required filter introduce the reported symptom.
     */
    FilterConfigurationIntroducedSymptom: 'filter_configuration_introduced_symptom',

    /**
     * A newly proposed candidate rule was verified to resolve the symptom.
     */
    CandidateValidated: 'candidate_validated',

    /**
     * No verified resolution was found among the observed candidates.
     */
    NoVerifiedResolution: 'no_verified_resolution',

    /**
     * The observation set does not cover every state this classifier requires.
     */
    IncompleteEvidence: 'incomplete_evidence',

    /**
     * No browser was available to run the investigation.
     */
    BrowserUnavailable: 'browser_unavailable',

    /**
     * The run failed for a reason unrelated to browser availability.
     */
    RunFailed: 'run_failed',
} as const;

/**
 * Every CurrentEnvironmentReason value, for schemas and exhaustive listings.
 */
export const CURRENT_ENVIRONMENT_REASON_VALUES = Object.values(CurrentEnvironmentReason);

/**
 * CurrentEnvironmentReason value.
 */
export type CurrentEnvironmentReason =
    (typeof CurrentEnvironmentReason)[keyof typeof CurrentEnvironmentReason];

/**
 * Terminal status and the vision-evidence branch that selected it.
 */
export interface CurrentEnvironmentClassification {
    /**
     * Product outcome for the local current-environment run.
     */
    status: FixRunStatus;

    /**
     * Stable machine-readable explanation of the classification.
     */
    reason: CurrentEnvironmentReason;
}

/**
 * Classify explicit vision observations without deriving page meaning from browser facts.
 *
 * The unfiltered control is the baseline that distinguishes a real current filter fix from site
 * drift. A completed reporter profile that disagrees with the controlled profile is classified as
 * configuration-specific before considering rule candidates.
 *
 * @param observations - Browser reproduction and rule-validation observations.
 * @returns Deterministic current-environment status and reason code.
 */
export function classifyCurrentEnvironment(
    observations: CurrentEnvironmentObservations,
): CurrentEnvironmentClassification {
    if (observations.fatalError !== undefined) {
        return { status: FixRunStatus.Failed, reason: CurrentEnvironmentReason.RunFailed };
    }
    if (!observations.browserAvailable) {
        return {
            status: FixRunStatus.BrowserUnavailable,
            reason: CurrentEnvironmentReason.BrowserUnavailable,
        };
    }
    if (
        !observations.analysisComplete ||
        observations.unfiltered === SymptomObservation.Partial ||
        observations.unfiltered === SymptomObservation.NotRun ||
        observations.defaultsPlusRequired === SymptomObservation.Partial ||
        observations.defaultsPlusRequired === SymptomObservation.NotRun ||
        observations.reported === SymptomObservation.Partial
    ) {
        return {
            status: FixRunStatus.AnalysisOnly,
            reason: CurrentEnvironmentReason.IncompleteEvidence,
        };
    }

    if (
        observations.reported !== SymptomObservation.NotRun &&
        observations.reported !== observations.defaultsPlusRequired
    ) {
        return {
            status: FixRunStatus.ConfigurationSpecific,
            reason: CurrentEnvironmentReason.ReporterConfigurationConflict,
        };
    }

    if (observations.unfiltered === SymptomObservation.NotReproduced) {
        if (observations.defaultsPlusRequired === SymptomObservation.NotReproduced) {
            return {
                status: FixRunStatus.NotReproduced,
                reason: CurrentEnvironmentReason.SiteDrift,
            };
        }
        return {
            status: FixRunStatus.ConfigurationSpecific,
            reason: CurrentEnvironmentReason.FilterConfigurationIntroducedSymptom,
        };
    }

    if (observations.defaultsPlusRequired === SymptomObservation.NotReproduced) {
        return {
            status: FixRunStatus.AlreadyFixedCurrent,
            reason: CurrentEnvironmentReason.CurrentFiltersFixed,
        };
    }
    if (observations.candidate === RuleValidationObservation.Passed) {
        return {
            status: FixRunStatus.PatchProposed,
            reason: CurrentEnvironmentReason.CandidateValidated,
        };
    }
    if (observations.candidate === RuleValidationObservation.Partial) {
        return {
            status: FixRunStatus.AnalysisOnly,
            reason: CurrentEnvironmentReason.IncompleteEvidence,
        };
    }
    return {
        status: FixRunStatus.AnalysisOnly,
        reason: CurrentEnvironmentReason.NoVerifiedResolution,
    };
}

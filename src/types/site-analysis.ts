import * as v from 'valibot';
import { ReproProfileSchema } from './repro-profile';

/**
 * The type of ad or tracker finding.
 */
export const FindingType = {
    /**
     * An advertisement.
     */
    Ad: 'ad',

    /**
     * A tracking script or request.
     */
    Tracker: 'tracker',

    /**
     * A cosmetic annoyance such as a popup, overlay, or newsletter prompt.
     */
    Annoyance: 'annoyance',

    /**
     * A measure that detects and reacts to an ad blocker.
     */
    AntiAdblock: 'anti-adblock',

    /**
     * An element or request that is suspicious but does not fit another category.
     */
    Suspicious: 'suspicious',
} as const;

/**
 * Every FindingType value, for schemas and exhaustive listings.
 */
export const FINDING_TYPE_VALUES = Object.values(FindingType);

/**
 * The type of ad or tracker finding (ad, tracker, annoyance, anti-adblock, or suspicious).
 */
export const FindingTypeSchema = v.picklist(FINDING_TYPE_VALUES);

/**
 * The location of the finding, expressed as a selector, URL pattern, or frame URL.
 */
export const FindingLocationSchema = v.object({
    /**
     * A CSS selector identifying the element.
     */
    selector: v.optional(v.string()),

    /**
     * A URL pattern that matched the network request.
     */
    urlPattern: v.optional(v.string()),

    /**
     * URL of the iframe or sub-frame containing the finding.
     */
    frameUrl: v.optional(v.string()),
});

/**
 * A single finding about an ad, tracker, annoyance, anti-adblock measure, or suspicious element.
 */
export const FindingSchema = v.object({
    /**
     * The category of the finding.
     */
    type: FindingTypeSchema,

    /**
     * Where the finding was observed (CSS selector, URL pattern, or frame URL).
     */
    location: FindingLocationSchema,

    /**
     * Human-readable description of the evidence.
     */
    evidence: v.string(),

    /**
     * Confidence level: 0 (uncertain) to 1 (certain).
     */
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),

    /**
     * Suggested approach to block or address the finding.
     */
    suggestedApproach: v.optional(v.string()),
});

/**
 * A screenshot from the original issue matched against a live screenshot artifact.
 */
export const MatchedIssueScreenshotSchema = v.object({
    /**
     * URL of the screenshot from the issue.
     */
    issueScreenshotUrl: v.string(),

    /**
     * Artifact ID of the live screenshot, if successfully captured.
     */
    liveArtifactId: v.optional(v.string()),

    /**
     * Description of the match or the failure reason.
     */
    description: v.string(),
});

/**
 * A full site analysis report produced after a live browser session.
 */
export const SiteAnalysisReportSchema = v.object({
    /**
     * The URL that was analyzed.
     */
    url: v.string(),

    /**
     * The reproduction profile used for the session.
     */
    reproProfile: ReproProfileSchema,

    /**
     * Screenshot artifact IDs captured during the session.
     */
    screenshots: v.array(v.string()),

    /**
     * Artifact ID of the full DOM snapshot, if captured.
     */
    domSnapshotArtifactId: v.optional(v.string()),

    /**
     * Artifact ID of the redacted HAR (network log), if captured.
     */
    harArtifactId: v.optional(v.string()),

    /**
     * Findings reported by the LLM during the session.
     */
    findings: v.array(FindingSchema),

    /**
     * Issue screenshots matched against live captures.
     */
    matchedIssueScreenshots: v.array(MatchedIssueScreenshotSchema),

    /**
     * Whether the target site could not be reached.
     */
    unreachable: v.boolean(),

    /**
     * Error message explaining why the site was unreachable, when applicable.
     */
    unreachableError: v.optional(v.string()),
});

/**
 * FindingType value.
 */
export type FindingType = (typeof FindingType)[keyof typeof FindingType];

/**
 * The location of a finding.
 */
export type FindingLocation = v.InferOutput<typeof FindingLocationSchema>;

/**
 * A single finding about an ad, tracker, annoyance, anti-adblock measure, or suspicious element.
 */
export type Finding = v.InferOutput<typeof FindingSchema>;

/**
 * A matched issue screenshot reference.
 */
export type MatchedIssueScreenshot = v.InferOutput<typeof MatchedIssueScreenshotSchema>;

/**
 * A full site analysis report.
 */
export type SiteAnalysisReport = v.InferOutput<typeof SiteAnalysisReportSchema>;

import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import { SafeInteractionRefusalReason, type SafeInteractionRecord } from './safe-interaction';

/**
 * Longest bounded structural string one scanned surface may report.
 *
 * The schema below rejects any longer string, and the browser-side annoyance probe truncates every
 * page-controlled fact to the same cap before handing the scan over, so producer and consumer share
 * this one declaration. 300 characters keeps a realistic class list or accessible label intact
 * while denying a hostile page an unbounded text channel out of the scan.
 */
export const MAX_SURFACE_FACT_LENGTH = 300;

/**
 * Highest stacking order one scanned surface may report.
 *
 * The probe clamps every observed stacking order to this ceiling and the schema below re-checks it.
 * A million sits far above any stacking context a real page builds, so clamping preserves the
 * relative order of genuine surfaces while keeping a page-controlled number bounded.
 */
export const MAX_SURFACE_STACK_ORDER = 1_000_000;

/**
 * Share of the viewport, in permille, a surface must exceed to be dominant on geometry alone.
 */
const DOMINANT_COVERAGE_PERMILLE = 200;

/**
 * Fraction of the baseline document height below which the candidate page has lost its content.
 */
const CONTENT_LOSS_RATIO = 2;

const BoundedSurfaceTextSchema = v.pipe(v.string(), v.maxLength(MAX_SURFACE_FACT_LENGTH));

export const AnnoyanceSurfaceFactsSchema = v.strictObject({
    tagName: BoundedSurfaceTextSchema,
    elementId: BoundedSurfaceTextSchema,
    elementClasses: BoundedSurfaceTextSchema,
    elementRole: BoundedSurfaceTextSchema,
    accessibleLabel: BoundedSurfaceTextSchema,
    positionMode: v.picklist(['fixed', 'sticky', 'absolute', 'static']),
    stackOrder: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_SURFACE_STACK_ORDER)),
    viewportCoverage: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000)),
    coversViewportCenter: v.boolean(),
});

/**
 * Bounded structural facts about one obstructing surface on the interacted page.
 */
export type AnnoyanceSurfaceFacts = v.InferOutput<typeof AnnoyanceSurfaceFactsSchema>;

/**
 * Most obstructing surfaces one scan retains as evidence.
 */
export const MAX_SCANNED_SURFACES = 12;

export const AnnoyanceSurfaceScanSchema = v.strictObject({
    surfaces: v.pipe(v.array(AnnoyanceSurfaceFactsSchema), v.maxLength(MAX_SCANNED_SURFACES)),
    surfaceCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
    scrollLocked: v.boolean(),
    documentHeight: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

/**
 * Bounded ordered obstruction scan of one interacted page.
 */
export type AnnoyanceSurfaceScan = v.InferOutput<typeof AnnoyanceSurfaceScanSchema>;

/**
 * Identity of the annoyance surface one phase revealed.
 */
export interface AnnoyanceTarget {
    /**
     * SHA-256 over the canonical positional identity form of the dominant surface.
     */
    signature: string;

    /**
     * Bounded structural facts recorded for that surface.
     */
    surface: AnnoyanceSurfaceFacts;

    /**
     * Zero-based interaction step after which it became dominant, or -1 when it preceded them.
     */
    revealedAtStepIndex: number;
}

/**
 * Finite reason the page the run drove is no longer usable under the candidate.
 */
export const InteractedPageRegression = {
    /**
     * No regression: the interacted page remains as usable as it was under the baseline.
     */
    None: 'none',

    /**
     * A replayed step did not do what the baseline step did, and not because its target was refused
     * as unavailable.
     */
    InteractionDiverged: 'interaction_diverged',

    /**
     * The candidate scan found the page scroll-locked when the baseline scan did not.
     */
    ScrollLocked: 'scroll_locked',

    /**
     * The candidate document height dropped below the baseline's by more than the content-loss
     * ratio, meaning the page lost its content.
     */
    ContentLost: 'content_lost',

    /**
     * The baseline or candidate scan needed to judge usability is missing.
     */
    ObservationUnavailable: 'observation_unavailable',
} as const;

/**
 * Every InteractedPageRegression value, for schemas and exhaustive listings.
 */
export const INTERACTED_PAGE_REGRESSION_VALUES = Object.values(InteractedPageRegression);

export const InteractedPageRegressionSchema = v.picklist(INTERACTED_PAGE_REGRESSION_VALUES);

/**
 * InteractedPageRegression value.
 */
export type InteractedPageRegression =
    (typeof InteractedPageRegression)[keyof typeof InteractedPageRegression];

/**
 * Whether the interacted page still works, and the finite regression that decided it.
 */
export interface InteractedPageUsability {
    /**
     * Whether the page the run drove remains usable; true for exactly one regression.
     */
    usable: boolean;

    /**
     * Finite regression that decided usability, or `none`.
     */
    regression: InteractedPageRegression;
}

/**
 * Everything the interacted-page usability decision reads.
 */
export interface InteractedPageUsabilityInput {
    /**
     * Scan taken after the baseline sequence.
     */
    baselineScan: AnnoyanceSurfaceScan | null;

    /**
     * Scan taken after the replayed sequence.
     */
    candidateScan: AnnoyanceSurfaceScan | null;

    /**
     * Ordered evidence of the baseline sequence.
     */
    baselineRecord: SafeInteractionRecord;

    /**
     * Ordered evidence of the replayed sequence.
     */
    candidateRecord: SafeInteractionRecord;
}

/**
 * Reduce one surface's coverage to the decile the identity signature is stable across.
 *
 * Two scans of the same surface rarely agree on the exact permille, so the identity is taken at a
 * coarser resolution than the measurement.
 *
 * @param surface - Bounded structural facts about one surface.
 * @returns Coverage decile of that surface.
 */
function coverageDecile(surface: AnnoyanceSurfaceFacts): number {
    return Math.round(surface.viewportCoverage / 100);
}

/**
 * Hash the canonical positional identity form of one surface.
 *
 * The form is positional rather than keyed, matching the interaction-plan digest convention, and it
 * deliberately excludes `stackOrder` and `coversViewportCenter`: both vary with scroll position
 * between two otherwise identical observations of the same surface.
 *
 * @param surface - Bounded structural facts about one surface.
 * @returns Hex SHA-256 over the canonical identity form.
 */
function surfaceSignature(surface: AnnoyanceSurfaceFacts): string {
    const canonical = JSON.stringify([
        surface.tagName,
        surface.elementId,
        surface.elementClasses,
        surface.elementRole,
        surface.accessibleLabel,
        surface.positionMode,
        coverageDecile(surface),
    ]);
    return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Decide whether one surface obstructs the page enough to be the reported annoyance.
 *
 * Geometry decides, not wording: a surface that owns the viewport centre or more than a fifth of
 * the viewport is obstructing regardless of what it calls itself.
 *
 * @param surface - Bounded structural facts about one surface.
 * @returns Whether the surface qualifies as the dominant obstruction.
 */
function isDominant(surface: AnnoyanceSurfaceFacts): boolean {
    if (surface.positionMode === 'static') {
        return false;
    }
    return surface.coversViewportCenter || surface.viewportCoverage > DOMINANT_COVERAGE_PERMILLE;
}

/**
 * Reduce one post-interaction scan to the single surface that is the reported annoyance.
 *
 * @param scan - Post-interaction obstruction scan, or null when the page could not be scanned.
 * @param revealedAtStepIndex - Step after which the scan was taken, or -1 for a pre-interaction
 *   scan.
 * @returns The dominant surface's identity, or null when no surface is dominant.
 */
export function selectAnnoyanceTarget(
    scan: AnnoyanceSurfaceScan | null,
    revealedAtStepIndex: number,
): AnnoyanceTarget | null {
    if (scan === null) {
        return null;
    }
    let dominant: AnnoyanceSurfaceFacts | null = null;
    for (const surface of scan.surfaces) {
        if (!isDominant(surface)) {
            continue;
        }
        if (dominant === null || surface.viewportCoverage > dominant.viewportCoverage) {
            dominant = surface;
        }
    }
    if (dominant === null) {
        return null;
    }
    return {
        signature: surfaceSignature(dominant),
        surface: dominant,
        revealedAtStepIndex,
    };
}

/**
 * Decide whether one scanned surface could be the recorded annoyance wearing different markup.
 *
 * @param target - Identity recorded by the phase that reproduced the annoyance.
 * @param surface - Bounded structural facts about one scanned surface.
 * @returns Whether the surface is close enough that removal cannot be claimed.
 */
function isComparable(target: AnnoyanceTarget, surface: AnnoyanceSurfaceFacts): boolean {
    return (
        surface.positionMode === target.surface.positionMode &&
        surface.elementRole === target.surface.elementRole &&
        Math.abs(coverageDecile(surface) - coverageDecile(target.surface)) <= 1
    );
}

/**
 * Decide whether the recorded annoyance is still on the page.
 *
 * A drifted but comparable surface reports `indeterminate` rather than `absent`, so an annoyance
 * that merely changed its markup can never be credited as removed.
 *
 * @param target - Identity recorded by the phase that reproduced the annoyance.
 * @param scan - Post-interaction scan of the phase being judged, or null when unavailable.
 * @returns Whether that same annoyance is present, absent, or undecidable.
 */
export function correlateAnnoyanceTarget(
    target: AnnoyanceTarget,
    scan: AnnoyanceSurfaceScan | null,
): ReporterSymptomPresence {
    if (scan === null) {
        return ReporterSymptomPresence.Indeterminate;
    }
    if (scan.surfaces.some((surface) => surfaceSignature(surface) === target.signature)) {
        return ReporterSymptomPresence.Present;
    }
    if (scan.surfaces.some((surface) => isComparable(target, surface))) {
        return ReporterSymptomPresence.Indeterminate;
    }
    return ReporterSymptomPresence.Absent;
}

/**
 * Find the first replayed step that did not do what the baseline step did.
 *
 * A step the candidate refused because its control is no longer there is the expected shape of a
 * working fix, not a divergence: the candidate removed the very surface that step addressed.
 *
 * @param input - Baseline and candidate interaction records.
 * @returns The regression the replay proves, or `none` when nothing diverged.
 */
function replayRegression(input: InteractedPageUsabilityInput): InteractedPageRegression {
    const shared = Math.min(input.baselineRecord.steps.length, input.candidateRecord.steps.length);
    for (let index = 0; index < shared; index += 1) {
        const baseline = input.baselineRecord.steps[index]!;
        const candidate = input.candidateRecord.steps[index]!;
        if (baseline.outcome !== 'performed' || candidate.outcome === 'performed') {
            continue;
        }
        return candidate.refusalReason === SafeInteractionRefusalReason.TargetUnavailable
            ? InteractedPageRegression.None
            : InteractedPageRegression.InteractionDiverged;
    }
    return InteractedPageRegression.None;
}

/**
 * Build one usability outcome, deriving the boolean from the regression in exactly one place.
 *
 * @param regression - Finite regression that decided usability.
 * @returns Complete usability decision.
 */
function decide(regression: InteractedPageRegression): InteractedPageUsability {
    return { usable: regression === InteractedPageRegression.None, regression };
}

/**
 * Decide whether the page the run interacted with is still usable under the candidate.
 *
 * @param input - Baseline and candidate scans plus both interaction records.
 * @returns Usability with the finite regression that decided it.
 */
export function assessInteractedPageUsability(
    input: InteractedPageUsabilityInput,
): InteractedPageUsability {
    const baselineScan = input.baselineScan;
    const candidateScan = input.candidateScan;
    if (baselineScan === null || candidateScan === null) {
        return decide(InteractedPageRegression.ObservationUnavailable);
    }

    const replay = replayRegression(input);
    if (replay !== InteractedPageRegression.None) {
        return decide(replay);
    }
    if (candidateScan.scrollLocked && !baselineScan.scrollLocked) {
        return decide(InteractedPageRegression.ScrollLocked);
    }
    if (candidateScan.documentHeight < baselineScan.documentHeight / CONTENT_LOSS_RATIO) {
        return decide(InteractedPageRegression.ContentLost);
    }
    return decide(InteractedPageRegression.None);
}

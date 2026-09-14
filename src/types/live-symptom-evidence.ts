import * as v from 'valibot';
import { SymptomObservationSchema } from './fix-run-result';

/**
 * Explicit terminal marker required from the live-page vision comparison.
 */
export const LiveSymptomMarker = {
    /**
     * The live screenshot shows the reporter-defined defect.
     */
    Reproduced: 'REPRODUCED',

    /**
     * The live screenshot does not show the reporter-defined defect.
     */
    NotReproduced: 'NOT_REPRODUCED',

    /**
     * The vision comparison could not determine whether the defect is present.
     */
    Indeterminate: 'INDETERMINATE',
} as const;

/**
 * Every live symptom marker value, for schemas and exhaustive listings.
 */
export const LIVE_SYMPTOM_MARKER_VALUES = Object.values(LiveSymptomMarker);

/**
 * Live symptom marker value.
 */
export type LiveSymptomMarker = (typeof LiveSymptomMarker)[keyof typeof LiveSymptomMarker];

export const LiveSymptomMarkerSchema = v.picklist(LIVE_SYMPTOM_MARKER_VALUES);

export const LiveSymptomEvidenceSchema = v.pipe(
    v.object({
        reporterScreenshotArtifactIds: v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1))),
            v.minLength(1),
        ),
        reporterSymptomDescription: v.pipe(v.string(), v.minLength(1), v.maxLength(1_200)),
        liveScreenshotArtifactId: v.pipe(v.string(), v.minLength(1)),
        marker: LiveSymptomMarkerSchema,
        markerPresent: v.boolean(),
        observation: SymptomObservationSchema,
        model: v.nullable(v.string()),
        analysis: v.nullable(v.pipe(v.string(), v.maxLength(8_000))),
        error: v.nullable(v.pipe(v.string(), v.maxLength(500))),
    }),
    v.check(
        (evidence) =>
            (evidence.marker === LiveSymptomMarker.Reproduced &&
                evidence.markerPresent &&
                evidence.observation === 'reproduced') ||
            (evidence.marker === LiveSymptomMarker.NotReproduced &&
                evidence.markerPresent &&
                evidence.observation === 'not_reproduced') ||
            (evidence.marker === LiveSymptomMarker.Indeterminate &&
                evidence.observation === 'indeterminate'),
        'Live symptom marker and typed observation must agree.',
    ),
);

/**
 * Typed evidence binding the reporter-defined defect to one live viewport screenshot.
 */
export type LiveSymptomEvidence = v.InferOutput<typeof LiveSymptomEvidenceSchema>;

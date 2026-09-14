import * as v from 'valibot';
import { CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN } from './candidate-artifact-identity';

/**
 * Maximum number of page-damage observations accepted from one visual review.
 */
const MAX_OBSERVED_DAMAGE_ITEMS = 20;

/**
 * Maximum number of repeated symptom instances accepted from one visual review.
 */
const MAX_VISUAL_INSTANCES = 50;

/**
 * Maximum number of tile observations reconciled for either page state.
 */
const MAX_INVENTORY_RECONCILIATIONS = 50;

/**
 * Non-empty artifact identifier emitted by the trusted runner.
 */
const ArtifactIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));

/**
 * Bounded natural-language explanation returned by the visual model.
 */
const RationaleSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(4_000));

/**
 * Bounded description of one visually observed non-target regression.
 */
const ObservedDamageItemSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(1_000));

/**
 * Bounded description of the complete reporter-defined symptom family inspected by vision.
 */
const SymptomScopeSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(2_000));

/**
 * How one reviewed symptom instance relates to the reporter's symptom.
 */
export const CandidateInstanceDisposition = {
    SameSymptom: 'same_symptom',
    NotSameSymptom: 'not_same_symptom',
    Remaining: 'remaining',
} as const;

/**
 * CandidateInstanceDisposition value.
 */
export type CandidateInstanceDisposition =
    (typeof CandidateInstanceDisposition)[keyof typeof CandidateInstanceDisposition];

/**
 * Final semantic verdict of one candidate visual review.
 */
export const CandidateVisualVerdict = {
    Verified: 'verified',
    Rejected: 'rejected',
    Inconclusive: 'inconclusive',
} as const;

/**
 * Every candidate visual verdict value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_VERDICT_VALUES = Object.values(CandidateVisualVerdict);

/**
 * Whether the reviewed candidate resolved the reporter's symptom.
 */
export const CandidateVisualSymptom = {
    Resolved: 'resolved',
    NotResolved: 'not_resolved',
    Unclear: 'unclear',
} as const;

/**
 * Every candidate visual symptom value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_SYMPTOM_VALUES = Object.values(CandidateVisualSymptom);

/**
 * Whether an ad-shaped layout residue remained after the candidate applied.
 */
export const CandidateVisualAdLayoutResidue = {
    Absent: 'absent',
    Present: 'present',
    Unclear: 'unclear',
} as const;

/**
 * Every ad layout residue value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES = Object.values(
    CandidateVisualAdLayoutResidue,
);

/**
 * Whether the page stayed intact after the candidate applied.
 */
export const CandidateVisualPageIntegrity = {
    Intact: 'intact',
    Regressed: 'regressed',
    Unclear: 'unclear',
} as const;

/**
 * Every page integrity value, for schemas and exhaustive listings.
 */
export const CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES = Object.values(CandidateVisualPageIntegrity);

/**
 * One visual occurrence tied to an exact runner-owned screenshot or tile artifact.
 */
export const CandidateVisualInstanceSchema = v.strictObject({
    artifactId: ArtifactIdSchema,
    landmark: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    description: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * Auditable final-model disposition of one before-state tile observation.
 */
export const CandidateVisualBeforeInventoryReconciliationSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.SameSymptom,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: RationaleSchema,
    instance: CandidateVisualInstanceSchema,
});

/**
 * Auditable final-model disposition of one after-state tile observation.
 */
export const CandidateVisualAfterInventoryReconciliationSchema = v.strictObject({
    observationIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
    disposition: v.picklist([
        CandidateInstanceDisposition.Remaining,
        CandidateInstanceDisposition.NotSameSymptom,
    ]),
    rationale: RationaleSchema,
    instance: CandidateVisualInstanceSchema,
});

/**
 * Complete audit trail binding every tile observation to the final semantic review.
 */
export const CandidateVisualInventoryReconciliationSchema = v.strictObject({
    before: v.pipe(
        v.array(CandidateVisualBeforeInventoryReconciliationSchema),
        v.maxLength(MAX_INVENTORY_RECONCILIATIONS),
    ),
    after: v.pipe(
        v.array(CandidateVisualAfterInventoryReconciliationSchema),
        v.maxLength(MAX_INVENTORY_RECONCILIATIONS),
    ),
});

/**
 * Final semantic outcome derived from the model's visual observations.
 */
export const CandidateVisualVerdictSchema = v.picklist(CANDIDATE_VISUAL_VERDICT_VALUES);

/**
 * Model judgment about whether the reported symptom disappeared after applying the candidate.
 */
export const CandidateVisualSymptomSchema = v.picklist(CANDIDATE_VISUAL_SYMPTOM_VALUES);

/**
 * Model judgment about reporter-related advertising layout left after the candidate.
 */
export const CandidateVisualAdLayoutResidueSchema = v.picklist(
    CANDIDATE_VISUAL_AD_LAYOUT_RESIDUE_VALUES,
);

/**
 * Model judgment about whether non-target page content remained visually intact.
 */
export const CandidateVisualPageIntegritySchema = v.picklist(
    CANDIDATE_VISUAL_PAGE_INTEGRITY_VALUES,
);

/**
 * Untrusted semantic output accepted directly from the visual model.
 *
 * Runner-bound artifact identifiers, candidate hashes, and the derived verdict are intentionally
 * excluded from this schema.
 */
export const CandidateVisualReviewModelOutputSchema = v.strictObject({
    symptom: CandidateVisualSymptomSchema,
    symptomScope: SymptomScopeSchema,
    adLayoutResidue: CandidateVisualAdLayoutResidueSchema,
    coverageComplete: v.boolean(),
    beforeInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_VISUAL_INSTANCES),
    ),
    remainingInstances: v.pipe(
        v.array(CandidateVisualInstanceSchema),
        v.maxLength(MAX_VISUAL_INSTANCES),
    ),
    pageIntegrity: CandidateVisualPageIntegritySchema,
    rationale: RationaleSchema,
    observedDamage: v.pipe(
        v.array(ObservedDamageItemSchema),
        v.maxLength(MAX_OBSERVED_DAMAGE_ITEMS),
    ),
});

/**
 * Runner-owned provenance for the full-page image used or safely omitted for vision.
 */
export const CandidateVisualFullPageOverviewEvidenceSchema = v.pipe(
    v.strictObject({
        mode: v.picklist([
            'original',
            'omitted_complete_tiles',
            'blocked_oversized_incomplete_tiles',
        ]),
        originalArtifactId: ArtifactIdSchema,
        originalBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
        visionArtifactId: v.nullable(ArtifactIdSchema),
        visionBytes: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
        reason: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
    }),
    v.check((evidence) => {
        if (evidence.mode === 'original') {
            return (
                evidence.visionArtifactId === evidence.originalArtifactId &&
                evidence.visionBytes === evidence.originalBytes &&
                evidence.reason === null
            );
        }
        return (
            evidence.visionArtifactId === null &&
            evidence.visionBytes === null &&
            evidence.reason !== null
        );
    }, 'Full-page overview provenance must bind original and vision artifacts consistently.'),
);

/**
 * Trusted visual-review record bound by the runner to one candidate and four evidence images.
 */
export const CandidateVisualReviewSchema = v.pipe(
    v.strictObject({
        verdict: CandidateVisualVerdictSchema,
        symptom: CandidateVisualSymptomSchema,
        symptomScope: SymptomScopeSchema,
        adLayoutResidue: CandidateVisualAdLayoutResidueSchema,
        coverageComplete: v.boolean(),
        beforeInstances: v.pipe(
            v.array(CandidateVisualInstanceSchema),
            v.maxLength(MAX_VISUAL_INSTANCES),
        ),
        remainingInstances: v.pipe(
            v.array(CandidateVisualInstanceSchema),
            v.maxLength(MAX_VISUAL_INSTANCES),
        ),
        pageIntegrity: CandidateVisualPageIntegritySchema,
        validationArtifactId: v.pipe(v.string(), v.regex(CANDIDATE_VALIDATION_ARTIFACT_ID_PATTERN)),
        candidateRuleHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        beforeViewportArtifactId: ArtifactIdSchema,
        afterViewportArtifactId: ArtifactIdSchema,
        beforeFullPageArtifactId: ArtifactIdSchema,
        afterFullPageArtifactId: ArtifactIdSchema,
        fullPageOverviewEvidence: v.optional(
            v.strictObject({
                before: CandidateVisualFullPageOverviewEvidenceSchema,
                after: CandidateVisualFullPageOverviewEvidenceSchema,
            }),
        ),
        model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        rationale: RationaleSchema,
        observedDamage: v.pipe(
            v.array(ObservedDamageItemSchema),
            v.maxLength(MAX_OBSERVED_DAMAGE_ITEMS),
        ),
        inventoryReconciliation: v.optional(CandidateVisualInventoryReconciliationSchema),
    }),
    v.check(
        (review) => review.verdict === deriveCandidateVisualVerdict(review),
        'Visual review verdict must match its semantic observations.',
    ),
);

/**
 * Final semantic outcome of a candidate visual review.
 */
export type CandidateVisualVerdict = v.InferOutput<typeof CandidateVisualVerdictSchema>;

/**
 * Model judgment about resolution of the reporter-defined symptom.
 */
export type CandidateVisualSymptom = v.InferOutput<typeof CandidateVisualSymptomSchema>;

/**
 * Vision-owned state of advertising wrappers, labels, frames, or reserved space after a fix.
 */
export type CandidateVisualAdLayoutResidue = v.InferOutput<
    typeof CandidateVisualAdLayoutResidueSchema
>;

/**
 * Model judgment about visible non-target page integrity.
 */
export type CandidateVisualPageIntegrity = v.InferOutput<typeof CandidateVisualPageIntegritySchema>;

/**
 * One visual symptom occurrence tied to an evidence artifact and page landmark.
 */
export type CandidateVisualInstance = v.InferOutput<typeof CandidateVisualInstanceSchema>;

/**
 * Complete auditable dispositions for the before and after tile inventories.
 */
export type CandidateVisualInventoryReconciliation = v.InferOutput<
    typeof CandidateVisualInventoryReconciliationSchema
>;

/**
 * Untrusted semantic output returned by the visual model.
 */
export type CandidateVisualReviewModelOutput = v.InferOutput<
    typeof CandidateVisualReviewModelOutputSchema
>;

/**
 * Runner-owned provenance for one full-page overview supplied to or omitted from vision.
 */
export type CandidateVisualFullPageOverviewEvidence = v.InferOutput<
    typeof CandidateVisualFullPageOverviewEvidenceSchema
>;

/**
 * Trusted runner-bound record of a candidate visual review.
 */
export type CandidateVisualReview = v.InferOutput<typeof CandidateVisualReviewSchema>;

/**
 * Derives the final verdict from the model's independent symptom and integrity judgments.
 *
 * @param output - Parsed semantic output returned by the visual model.
 * @returns The final candidate verdict enforced by the runner.
 */
export function deriveCandidateVisualVerdict(
    output: CandidateVisualReviewModelOutput,
): CandidateVisualVerdict {
    if (
        output.symptom === CandidateVisualSymptom.NotResolved ||
        output.adLayoutResidue === CandidateVisualAdLayoutResidue.Present ||
        output.remainingInstances.length > 0 ||
        output.pageIntegrity === CandidateVisualPageIntegrity.Regressed
    ) {
        return CandidateVisualVerdict.Rejected;
    }

    if (
        output.symptom === CandidateVisualSymptom.Resolved &&
        output.adLayoutResidue === CandidateVisualAdLayoutResidue.Absent &&
        output.coverageComplete &&
        output.beforeInstances.length > 0 &&
        output.pageIntegrity === CandidateVisualPageIntegrity.Intact
    ) {
        return CandidateVisualVerdict.Verified;
    }

    return CandidateVisualVerdict.Inconclusive;
}

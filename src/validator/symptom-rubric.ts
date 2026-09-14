import { isIncorrectBlockingReport, type ProblemType } from '../types/issue-facts';

/**
 * Named symptom kinds, so review code never spells one inline.
 */
export const SymptomKind = {
    Ads: 'ads',
    Breakage: 'incorrect_blocking',
} as const;

/**
 * Problem class driving the visual review rubric.
 *
 * Ads-class runs judge whether an advertising footprint disappeared; incorrect-blocking runs judge
 * the inverse — whether functionality that filtering had broken is visibly restored.
 */
export type SymptomKind = (typeof SymptomKind)[keyof typeof SymptomKind];

/**
 * Whether a review judges broken functionality rather than an advertising footprint.
 *
 * @param kind - Problem class driving the review, ads when omitted.
 * @returns True when the reviewed defect is content the filtering removed.
 */
export function isBreakageSymptom(kind?: SymptomKind): boolean {
    return kind === SymptomKind.Breakage;
}

/**
 * Map a parsed issue problem type onto the review rubric class.
 *
 * The single mapping point keeps every runner and tool registry consistent: anything that is not an
 * incorrect-blocking report reviews under ads semantics.
 *
 * @param problemType - Parsed problem type of the issue, when known.
 * @returns The rubric class the run must review under.
 */
export function symptomKindForProblemType(problemType?: ProblemType): SymptomKind {
    return isIncorrectBlockingReport(problemType) ? SymptomKind.Breakage : SymptomKind.Ads;
}

/**
 * Residue rubric lines for the per-image inventory prompts (tiles and overviews).
 *
 * The ads wording is load-bearing verbatim: existing review contracts pin it. The breakage wording
 * inverts the AFTER-state semantics — restored content must not be recorded as a matching
 * instance.
 *
 * @param kind - Problem class driving the review.
 * @returns Prompt lines describing what counts as a matching symptom instance.
 */
export function inventoryResidueRubric(kind: SymptomKind): string[] {
    if (isBreakageSymptom(kind)) {
        return [
            'The reporter-defined defect is broken or missing page functionality caused by',
            'filtering: a missing image or video, an empty region where content should render,',
            'a control that visibly fails, or an on-page error message. In the BEFORE state',
            'record each such breakage instance. In the AFTER state record an instance only',
            'when the same functionality is still visibly broken or missing; restored working',
            'content is not a matching instance. Separately, in BOTH states, record every',
            'visible advertisement as an observation prefixed "AD PRESENCE:" with its location',
            '— including in the BEFORE state, where ad presence must be recorded even though it',
            'is not candidate damage. These observations feed the filtering-regression check.',
        ];
    }
    return [
        'Treat an outer ad wrapper, its REKLAMA label, divider or frame, and reserved',
        'blank space or height as part of the reporter-defined advertising symptom',
        'footprint. In the AFTER state, record any such residual as a matching',
        'instance even when the ad creative itself disappeared.',
    ];
}

/**
 * Residue rubric lines for the final text-only synthesis prompt.
 *
 * For breakage reviews the `adLayoutResidue` field is repurposed as the filtering-regression guard:
 * it must be `present` exactly when an advertising element that the baseline filters had removed
 * became visible again after the candidate — a too-broad exception then fails closed.
 *
 * @param kind - Problem class driving the review.
 * @returns Prompt lines defining residue and the adLayoutResidue contract.
 */
export function synthesisResidueRubric(kind: SymptomKind): string[] {
    if (isBreakageSymptom(kind)) {
        return [
            'The reporter-defined defect is broken or missing page functionality caused by',
            'filtering. An AFTER observation is remaining only when the same functionality is',
            'still visibly broken or missing; restored working content is normal page content,',
            'not residue. For this breakage review, set adLayoutResidue=present ONLY when an',
            'advertisement that was absent in BEFORE became visible in AFTER — that means the',
            'candidate exception also disabled legitimate filtering and the fix is not',
            'acceptable. Ground this strictly in the recorded "AD PRESENCE:" observations:',
            'present when an AFTER inventory records an advertisement with no matching BEFORE',
            'record, absent when no such new advertisement was recorded, and unclear when the',
            'inventories carry no usable ad-presence observations. Page integrity',
            'is independent: a readable intact page whose reported functionality is still',
            'broken is still not fixed.',
        ];
    }
    return [
        'An outer ad wrapper, REKLAMA',
        'label, divider or frame, or reserved blank space or height at a removed advertising',
        'region is reporter-related residue, not normal spacing. Set adLayoutResidue=present',
        'when any such residue remains, absent only when the full advertising footprint is',
        'gone, and unclear when the visual evidence cannot distinguish the two. Page integrity',
        'is independent: a readable intact page with residual ad layout is still not fixed.',
    ];
}

/**
 * The planning half of the candidate visual review: how the runner-owned screenshots of one page
 * state are measured and split into provider requests that stay inside the multimodal byte and
 * image-count budgets, before any of them is sent.
 *
 * It reads image sizes and returns request plans; it never talks to the vision provider and never
 * touches an inventory, so `candidate-visual-inventory` imports it and nothing is imported back.
 */
import { statSync } from 'node:fs';
import type { CandidateVisualFullPageOverviewEvidence } from '../types/candidate-visual-review';
import type {
    CandidateVisualEvidenceImage,
    CandidateVisualEvidenceTile,
} from './candidate-visual-evidence';

/**
 * Maximum original-resolution tiles sent in one provider request.
 */
const MAX_TILES_PER_VISION_BATCH = 3;

/**
 * Maximum raw screenshot bytes accepted in one multimodal provider request.
 *
 * Base64 encoding expands this to roughly eight MiB, leaving room for JSON and schema overhead
 * below the ten-MiB gateway limit used by supported local providers.
 */
const MAX_VISION_IMAGE_BYTES_PER_REQUEST = 6 * 1024 * 1024;

/**
 * Read and validate one evidence image's raw byte length.
 *
 * @param image - Runner-resolved evidence image whose local file will be sent to vision.
 * @returns Raw local screenshot byte length.
 */
export function evidenceImageBytes(image: CandidateVisualEvidenceImage): number {
    const bytes = statSync(image.path).size;
    if (bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST) {
        throw new Error(
            `Evidence image ${image.id} contains ${bytes} bytes and exceeds the per-request ` +
                `image byte budget of ${MAX_VISION_IMAGE_BYTES_PER_REQUEST} bytes.`,
        );
    }
    return bytes;
}

/**
 * Plan how one original full-page artifact participates in the bounded vision review.
 *
 * An oversized original is never mutated or sent beyond the provider byte limit. It may be omitted
 * only when a non-empty, mechanically complete original-resolution tile set covers the same state.
 * The schema keeps a distinct nullable vision artifact reference so omission cannot be confused
 * with the immutable original and a future derivative can extend the contract explicitly.
 *
 * @param image - Immutable runner-owned full-page evidence artifact.
 * @param coverageComplete - Whether the runner proved complete document tile coverage.
 * @param tiles - Ordered original-resolution tiles for the same page state.
 * @returns Validated provenance describing the original and vision-facing overview.
 */
export function planFullPageOverview(
    image: CandidateVisualEvidenceImage,
    coverageComplete: boolean,
    tiles: readonly CandidateVisualEvidenceTile[],
): CandidateVisualFullPageOverviewEvidence {
    const originalBytes = statSync(image.path).size;
    if (originalBytes <= MAX_VISION_IMAGE_BYTES_PER_REQUEST) {
        return {
            mode: 'original',
            originalArtifactId: image.id,
            originalBytes,
            visionArtifactId: image.id,
            visionBytes: originalBytes,
            reason: null,
        };
    }
    if (coverageComplete && tiles.length > 0) {
        return {
            mode: 'omitted_complete_tiles',
            originalArtifactId: image.id,
            originalBytes,
            visionArtifactId: null,
            visionBytes: null,
            reason:
                `Original full-page overview exceeds the ${MAX_VISION_IMAGE_BYTES_PER_REQUEST}-` +
                'byte vision request limit; complete original-resolution tiles provide visual ' +
                'coverage without altering the original artifact.',
        };
    }
    return {
        mode: 'blocked_oversized_incomplete_tiles',
        originalArtifactId: image.id,
        originalBytes,
        visionArtifactId: null,
        visionBytes: null,
        reason:
            `Original full-page overview exceeds the ${MAX_VISION_IMAGE_BYTES_PER_REQUEST}-byte ` +
            'vision request limit and complete original-resolution tiles are unavailable.',
    };
}

/**
 * Split page tiles into count- and byte-bounded provider requests without omitting any image.
 *
 * @param tiles - Complete ordered tile list for one page state.
 * @returns Ordered batches containing at most the configured image limit.
 */
export function tileBatches(tiles: CandidateVisualEvidenceTile[]): CandidateVisualEvidenceTile[][] {
    const batches: CandidateVisualEvidenceTile[][] = [];
    let current: CandidateVisualEvidenceTile[] = [];
    let currentBytes = 0;
    for (const tile of tiles) {
        const bytes = evidenceImageBytes(tile);
        if (
            current.length > 0 &&
            (current.length >= MAX_TILES_PER_VISION_BATCH ||
                currentBytes + bytes > MAX_VISION_IMAGE_BYTES_PER_REQUEST)
        ) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(tile);
        currentBytes += bytes;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}

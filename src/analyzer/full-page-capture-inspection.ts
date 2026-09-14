import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { MAX_VISION_IMAGE_BYTES } from '../pi/single-shot-input';
import { TraceEventType } from '../types/trace';
import {
    aggregateReporterSymptomPresence,
    imageBatches,
    inspectInventoryBatch,
    MAX_INVENTORY_INSTANCES,
    PreCandidateCaptureSchema,
    PreCandidateVisualBatchOutputSchema,
    resolveInventoryImage,
    resolveTileImages,
    type FullPageVisualCaptureOptions,
    type PreCandidateVisualInventory,
    type PreCandidateVisualInventoryResult,
    type ResolvedInventoryImage,
} from './full-page-visual-batches';

/**
 * Inspection of one already captured full page: bounded structured vision batches over the runner's
 * overview and original-resolution tiles, the coverage accounting that decides which exact
 * artifacts remain uninspected, and the persisted inventory artifact the retry guidance is read
 * from. Split out of `full-page-visual-inventory.ts`, which owns the pre-candidate capture flow;
 * the shared batching machinery both use lives in `full-page-visual-batches.ts`.
 */

/**
 * The `errorKind` the inspect_full_page_capture tool refuses an incomplete tile capture with.
 *
 * The session layer's diagnostic quarantine matches this exact token to disable the tool after
 * three incomplete captures in a row, so producer and matcher must spell it identically; it is
 * declared beside the capture concern rather than restated at the matcher.
 */
export const FULL_PAGE_CAPTURE_INCOMPLETE_KIND = 'full_page_capture_incomplete';

/**
 * One bounded image batch that vision could not conclusively inspect.
 */
export interface FullPageVisualBatchFailure {
    /**
     * Exact runner-owned images that remain uninspected.
     */
    artifactIds: string[];

    /**
     * Bounded technical or coverage diagnostic for retry guidance.
     */
    reason: string;
}

/**
 * Result of inspecting an existing full-page capture in bounded image batches.
 */
export interface FullPageVisualCaptureResult extends PreCandidateVisualInventoryResult {
    /**
     * Whether every required overview and tile image was conclusively inspected.
     */
    coverageComplete: boolean;

    /**
     * Exact images from successful vision batches.
     */
    inspectedArtifactIds: string[];

    /**
     * Exact images whose batch was unreadable, invalid, or explicitly incomplete.
     */
    missingArtifactIds: string[];

    /**
     * Bounded diagnostics grouped by failed image batch.
     */
    batchFailures: FullPageVisualBatchFailure[];
}

/**
 * Persist one complete or partial visual inventory under a capture-derived stable identity.
 *
 * @param options - Runner-owned artifact root and trace recorder.
 * @param inventory - Typed aggregate produced from successful image batches.
 * @param requiredArtifactIds - Ordered overview and tile identities defining this capture.
 * @param batchFailures - Bounded failures for batches that remain retryable.
 * @returns Registered artifact identity and canonical local path.
 */
function persistCaptureInventory(
    options: FullPageVisualCaptureOptions,
    inventory: PreCandidateVisualInventory,
    requiredArtifactIds: string[],
    batchFailures: FullPageVisualBatchFailure[],
): Pick<PreCandidateVisualInventoryResult, 'artifactId' | 'artifactPath'> {
    const digest = createHash('sha256')
        .update(requiredArtifactIds.join('\n'))
        .digest('hex')
        .slice(0, 16);
    const artifactId = `full-page-visual-inventory-${digest}`;
    const artifactPath = join(options.artifactsDir, `${artifactId}.json`);
    const serialized = `${JSON.stringify({ ...inventory, batchFailures }, null, 2)}\n`;
    writeFileSync(artifactPath, serialized, 'utf8');
    options.recorder.addArtifact({
        id: artifactId,
        path: artifactPath,
        type: 'full-page-visual-inventory',
        bytes: Buffer.byteLength(serialized),
    });
    return { artifactId, artifactPath };
}

/**
 * Inspect one already captured full page through bounded structured vision batches.
 *
 * Successful batches are retained even when a different batch is unreadable. The caller can
 * atomically credit those exact artifact IDs and retry only `missingArtifactIds` with the ordinary
 * single-image tool. Vision remains the source of semantic observations; this function only owns
 * artifact binding and coverage accounting.
 *
 * @param options - Vision provider, trace, reporter symptom, and artifact boundary.
 * @param rawCapture - Runner-owned screenshot result containing overview and complete tile
 *   coverage.
 * @returns Compact aggregate plus exact successful and missing artifact identities.
 */
export async function inspectFullPageVisualCapture(
    options: FullPageVisualCaptureOptions,
    rawCapture: unknown,
): Promise<FullPageVisualCaptureResult> {
    const capture = v.parse(PreCandidateCaptureSchema, rawCapture);
    const overview = resolveInventoryImage(
        options.recorder,
        options.artifactsDir,
        capture.fullPageArtifactId,
        'screenshot-full-page',
        'Complete page overview.',
    );
    const overviewVisionEligible = overview.bytes <= MAX_VISION_IMAGE_BYTES;
    const tiles = resolveTileImages(capture.tileCoverage, options.recorder, options.artifactsDir);
    const tileBatches = imageBatches(tiles);
    const batches: ResolvedInventoryImage[][] = [
        ...(overviewVisionEligible ? [[overview]] : []),
        ...tileBatches,
    ];
    const successfulOutputs: v.InferOutput<typeof PreCandidateVisualBatchOutputSchema>[] = [];
    const inspectedArtifactIds: string[] = [];
    const batchFailures: FullPageVisualBatchFailure[] = [];

    for (const [index, batch] of batches.entries()) {
        if (options.signal?.aborted) {
            // The tool deadline expired mid-batch. Every remaining batch is another paid vision
            // completion whose answer the aborted call can no longer return, so the loop stops and
            // the accounting below reports the uninspected artifacts as missing.
            batchFailures.push({
                artifactIds: batch.map((image) => image.id),
                reason: 'The vision tool deadline stopped the batch before this image batch ran.',
            });
            continue;
        }
        const label =
            overviewVisionEligible && index === 0
                ? 'full-page overview'
                : `original-resolution tile batch ${
                      overviewVisionEligible ? index : index + 1
                  } of ${tileBatches.length}`;
        try {
            const output = await inspectInventoryBatch(options, batch, label);
            if (!output.coverageObserved) {
                batchFailures.push({
                    artifactIds: batch.map((image) => image.id),
                    reason: output.rationale.slice(0, 1_000),
                });
                continue;
            }
            successfulOutputs.push(output);
            inspectedArtifactIds.push(...batch.map((image) => image.id));
        } catch (error) {
            batchFailures.push({
                artifactIds: batch.map((image) => image.id),
                reason: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
            });
        }
    }

    const instances = successfulOutputs.flatMap((output) => output.instances);
    const observationsFit = instances.length <= MAX_INVENTORY_INSTANCES;
    const coverageComplete =
        capture.tileCoverage.complete &&
        tiles.length > 0 &&
        batchFailures.length === 0 &&
        observationsFit;
    const inventory: PreCandidateVisualInventory = {
        coverageComplete,
        reporterSymptomPresence: aggregateReporterSymptomPresence(
            successfulOutputs,
            coverageComplete,
        ),
        overviewArtifactId: overview.id,
        tileArtifactIds: tiles.map((tile) => tile.id),
        symptomScopes: [...new Set(successfulOutputs.map((output) => output.symptomScope))],
        instances: instances.slice(0, MAX_INVENTORY_INSTANCES),
        model: options.vision.modelId.trim().slice(0, 200) || 'unknown-model',
        rationales: successfulOutputs.map((output) => output.rationale).slice(0, 20),
        ...(overviewVisionEligible ? {} : { excludedOversizedArtifactIds: [overview.id] }),
    };
    const requiredArtifactIds = [
        ...(overviewVisionEligible ? [overview.id] : []),
        ...tiles.map((tile) => tile.id),
    ];
    const missingArtifactIds = requiredArtifactIds.filter(
        (artifactId) => !inspectedArtifactIds.includes(artifactId),
    );
    const persisted = persistCaptureInventory(
        options,
        inventory,
        requiredArtifactIds,
        batchFailures,
    );
    options.recorder.record(TraceEventType.Decision, {
        phase: 'full_page_visual_inventory',
        coverageComplete,
        inspectedArtifactCount: inspectedArtifactIds.length,
        missingArtifactIds,
        artifactId: persisted.artifactId,
    });
    return {
        inventory,
        ...persisted,
        coverageComplete,
        inspectedArtifactIds,
        missingArtifactIds,
        batchFailures,
    };
}

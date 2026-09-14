import type { ArtifactRef } from '../types/trace';
import type { IArtifactStore } from './artifact-store';
import { redactPayload } from './redactor';

/**
 * The output of the context-curation middleware.
 */
export interface CuratedResult {
    /**
     * Token-bounded summary returned to the LLM in place of the raw tool result.
     */
    summary: Record<string, unknown>;

    /**
     * When a large result was stored as an artifact, the reference the LLM can use with
     * `get_detail` to retrieve slices.
     */
    artifactRef?: ArtifactRef;
}

/**
 * Options for {@link curateToolResult}.
 */
export interface CuratorOptions {
    /**
     * The artifact store used to persist large blobs.
     */
    store: IArtifactStore;

    /**
     * Approximate maximum character count for the summary.
     *
     * When the serialized result exceeds this threshold, it is stored as a referenced artifact and
     * the summary is truncated. Defaults to 4000.
     */
    maxChars?: number;

    /**
     * Whether to apply secret/PII redaction to the stored artifact content.
     *
     * Defaults to `true`.
     */
    redact?: boolean;
}

/**
 * Approximate characters-per-token ratio for English text.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Context-curation middleware.
 *
 * Wraps a raw tool result and decides whether to inline it into the LLM context or to persist it as
 * a referenced artifact with a token-bounded summary. Always applies secret/PII redaction before
 * storage.
 *
 * The middleware is pure: it does not mutate inputs and has no side effects beyond writing to the
 * artifact store.
 *
 * @param toolName - The name of the tool that produced the result.
 * @param args - The arguments that were passed to the tool.
 * @param rawResult - The raw result object returned by the tool handler.
 * @param options - Configuration including the artifact store and size threshold.
 * @returns The curated result with a summary (and optional artifact reference) for the LLM.
 */
export function curateToolResult(
    toolName: string,
    args: Record<string, unknown>,
    rawResult: Record<string, unknown>,
    options: CuratorOptions,
): CuratedResult {
    const maxChars = options.maxChars ?? 4000;
    const shouldRedact = options.redact !== false;

    const serialized = JSON.stringify(rawResult);
    const content = shouldRedact ? JSON.stringify(redactPayload(rawResult)) : serialized;

    // Small result → inline as-is
    if (serialized.length <= maxChars) {
        return { summary: rawResult };
    }

    // Large result → store as artifact, return summary
    const artifactRef = options.store.write(content, `tool_result.${toolName}`);

    // Build a token-bounded summary
    const summary: Record<string, unknown> = {
        metaArtifact: {
            id: artifactRef.id,
            type: artifactRef.type,
            bytes: artifactRef.bytes,
        },
        metaHint: `Result too large (${artifactRef.bytes} bytes). Use get_detail("${artifactRef.id}") to inspect slices.`,
    };

    // Include truncated preview
    const truncated = serialized.slice(0, maxChars);
    const parsed = tryParsePreview(truncated, rawResult);
    Object.assign(summary, parsed);

    return { summary, artifactRef };
}

/**
 * Build a preview from the truncated result, preserving top-level structure when possible.
 *
 * For objects, includes all top-level keys with truncated values. For other types, includes the raw
 * truncated string.
 *
 * @param truncated - The truncated JSON string.
 * @param rawResult - The original result object.
 * @returns A preview object suitable for the LLM summary.
 */
function tryParsePreview(
    truncated: string,
    rawResult: Record<string, unknown>,
): Record<string, unknown> {
    const preview: Record<string, unknown> = {};

    // Preserve top-level keys with truncated values
    for (const [key, value] of Object.entries(rawResult)) {
        if (typeof value === 'string') {
            const approxTokens = value.length / CHARS_PER_TOKEN;
            if (value.length > 500) {
                preview[key] =
                    `${value.slice(0, 500)}... [truncated, ~${Math.ceil(approxTokens)} tokens]`;
            } else {
                preview[key] = value;
            }
        } else if (Array.isArray(value)) {
            preview[key] = `[Array(${value.length})]`;
        } else if (typeof value === 'object' && value !== null) {
            preview[key] = `[Object keys: ${Object.keys(value).join(', ')}]`;
        } else {
            preview[key] = value;
        }
    }

    preview.metaTruncated = true;
    return preview;
}

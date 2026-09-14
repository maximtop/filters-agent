import * as v from 'valibot';

export const BenchmarkIssueMetadataSchema = v.strictObject({
    filtersBaseSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/i)),
});

/**
 * Historical benchmark metadata stored outside the prompt-safe issue view.
 */
export type BenchmarkIssueMetadata = v.InferOutput<typeof BenchmarkIssueMetadataSchema>;

/**
 * HTML comment carrying trusted benchmark-only metadata in an issue body.
 */
const BENCHMARK_MARKER_PATTERN = /<!--\s*adguard-agent-benchmark\s*:\s*([\s\S]*?)-->/gi;

/**
 * A standalone marker line, including its following newline when present.
 */
const BENCHMARK_MARKER_LINE_PATTERN =
    /^[ \t]*<!--\s*adguard-agent-benchmark\s*:\s*[\s\S]*?-->[ \t]*(?:\r?\n|$)/gim;

/**
 * Return fresh regular expression state for one marker operation.
 *
 * @param pattern - Shared marker expression whose source and flags should be cloned.
 * @returns A regular expression with an independent `lastIndex`.
 */
function clonePattern(pattern: RegExp): RegExp {
    return new RegExp(pattern.source, pattern.flags);
}

/**
 * Parse trusted historical metadata from an issue body.
 *
 * Missing metadata is valid for live issues. A present marker must be unique, contain only the
 * allowlisted fields, and use full Git commit SHAs.
 *
 * @param body - Raw issue body retained by the GitHub or local adapter.
 * @returns Validated historical metadata, or null when no marker exists.
 */
export function parseBenchmarkIssueMarker(body: string | null): BenchmarkIssueMetadata | null {
    if (body === null) {
        return null;
    }
    const matches = [...body.matchAll(clonePattern(BENCHMARK_MARKER_PATTERN))];
    if (matches.length === 0) {
        return null;
    }
    if (matches.length > 1) {
        throw new Error('Invalid benchmark marker: multiple markers are not allowed.');
    }

    let source: unknown;
    try {
        source = JSON.parse(matches[0]?.[1]?.trim() ?? '');
    } catch {
        throw new Error('Invalid benchmark marker: metadata must be a JSON object.');
    }
    const result = v.safeParse(BenchmarkIssueMetadataSchema, source);
    if (!result.success) {
        throw new Error(
            'Invalid benchmark marker: expected only filtersBaseSha as a full Git SHA.',
        );
    }
    return { filtersBaseSha: result.output.filtersBaseSha.toLowerCase() };
}

/**
 * Remove every benchmark metadata marker from an issue body before it enters an agent prompt.
 *
 * Stripping deliberately does not depend on successful trusted parsing: malformed hidden metadata
 * is still withheld from the model while the workflow gate can reject it independently.
 *
 * @param body - Raw issue body retained for audit.
 * @returns Prompt-safe issue body with benchmark comments removed.
 */
export function stripBenchmarkIssueMarker(body: string | null): string | null {
    if (body === null) {
        return null;
    }
    return body
        .replace(clonePattern(BENCHMARK_MARKER_LINE_PATTERN), '')
        .replace(clonePattern(BENCHMARK_MARKER_PATTERN), '')
        .trimEnd();
}

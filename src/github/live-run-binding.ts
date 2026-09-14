import * as v from 'valibot';

const FullCommitSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/iu));

const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/iu));

const RepositorySchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));

/**
 * Stable identity of one structured report inside an upstream issue.
 *
 * `<issue number>:body` or `<issue number>:comment:<comment id>` is the exact wire spelling the
 * intake workflow, this binding, the report branch index, and the runtime publisher exchange, so
 * the format is declared once here and imported by every other validator: a key one of them accepts
 * and another rejects would strand a queued report midway through the pipeline.
 */
export const ReportKeySchema = v.pipe(v.string(), v.regex(/^\d+:(?:body|comment:\d+)$/u));

const TaskIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{24}$/u));

/**
 * Hidden marker carrying one immutable live report binding.
 */
const LIVE_REPORT_MARKER_PATTERN = /<!--\s*adguard-filters-agent:live-report\s+([\s\S]*?)-->/giu;

/**
 * Hidden marker reserving one mirror before its issue-number-bound prompt can be finalized.
 */
const LIVE_RESERVATION_MARKER_PATTERN =
    /<!--\s*adguard-filters-agent:live-reservation\s+([\s\S]*?)-->/giu;

export const LiveMirrorReservationBindingSchema = v.strictObject({
    schemaVersion: v.literal(1),
    reportKey: ReportKeySchema,
    revisionDigest: Sha256Schema,
    filtersCurrentSha: FullCommitSchema,
    labSourceSha: FullCommitSchema,
    taskId: TaskIdSchema,
    repository: RepositorySchema,
});

/**
 * Durable identity written atomically with a newly-created private mirror.
 */
export type LiveMirrorReservationBinding = v.InferOutput<typeof LiveMirrorReservationBindingSchema>;

export const LiveRunBindingSchema = v.strictObject({
    schemaVersion: v.literal(1),
    environment: v.literal('current'),
    sourceIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    mirrorIssueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    reportKey: ReportKeySchema,
    revisionDigest: Sha256Schema,
    promptDigest: Sha256Schema,
    filtersCurrentSha: FullCommitSchema,
    labSourceSha: FullCommitSchema,
    repository: RepositorySchema,
});

/**
 * Immutable live-report identity supplied by the trusted intake workflow.
 */
export type LiveRunBinding = v.InferOutput<typeof LiveRunBindingSchema>;

/**
 * Normalize one trusted live-run binding before it enters a locked result.
 *
 * @param input - Unknown run configuration value.
 * @returns Strict lowercase digest and commit identity.
 */
export function parseLiveRunBinding(input: unknown): LiveRunBinding {
    const parsed = v.parse(LiveRunBindingSchema, input);
    return {
        ...parsed,
        revisionDigest: parsed.revisionDigest.toLowerCase(),
        promptDigest: parsed.promptDigest.toLowerCase(),
        filtersCurrentSha: parsed.filtersCurrentSha.toLowerCase(),
        labSourceSha: parsed.labSourceSha.toLowerCase(),
    };
}

/**
 * Normalize one provisional mirror reservation before it is persisted.
 *
 * @param input - Unknown provisional binding.
 * @returns Strict lowercase digest and commit identity.
 */
export function parseLiveMirrorReservationBinding(input: unknown): LiveMirrorReservationBinding {
    const parsed = v.parse(LiveMirrorReservationBindingSchema, input);
    return {
        ...parsed,
        revisionDigest: parsed.revisionDigest.toLowerCase(),
        filtersCurrentSha: parsed.filtersCurrentSha.toLowerCase(),
        labSourceSha: parsed.labSourceSha.toLowerCase(),
    };
}

/**
 * Render the exact trusted marker stored in a private live mirror issue.
 *
 * @param binding - Queue-selected report, prompt, filters, and lab identity.
 * @returns Hidden canonical marker.
 */
export function renderLiveMirrorMarker(binding: LiveRunBinding): string {
    return `<!-- adguard-filters-agent:live-report ${JSON.stringify(
        parseLiveRunBinding(binding),
    )} -->`;
}

/**
 * Render the provisional marker included in the atomic issue-create request.
 *
 * @param binding - Queue-selected identity available before allocating a mirror issue number.
 * @returns Hidden canonical reservation marker.
 */
export function renderLiveMirrorReservationMarker(binding: LiveMirrorReservationBinding): string {
    return `<!-- adguard-filters-agent:live-reservation ${JSON.stringify(
        parseLiveMirrorReservationBinding(binding),
    )} -->`;
}

/**
 * Parse a unique live mirror marker from an issue body.
 *
 * @param body - Current private lab issue body.
 * @returns Strict binding or null when the issue is not a live mirror.
 */
export function parseLiveMirrorMarker(body: string | null): LiveRunBinding | null {
    if (body === null) {
        return null;
    }
    const matches = [
        ...body.matchAll(
            new RegExp(LIVE_REPORT_MARKER_PATTERN.source, LIVE_REPORT_MARKER_PATTERN.flags),
        ),
    ];
    if (matches.length === 0) {
        return null;
    }
    if (matches.length !== 1) {
        throw new Error('Live report marker must appear exactly once.');
    }
    try {
        return parseLiveRunBinding(JSON.parse(matches[0]?.[1]?.trim() ?? ''));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('Live report marker must contain valid JSON.', { cause: error });
        }
        throw error;
    }
}

/**
 * Parse a unique provisional reservation marker from an issue body.
 *
 * @param body - Current private lab issue body.
 * @returns Strict provisional binding or null when the issue is not a reservation.
 */
export function parseLiveMirrorReservationMarker(
    body: string | null,
): LiveMirrorReservationBinding | null {
    if (body === null) {
        return null;
    }
    const matches = [
        ...body.matchAll(
            new RegExp(
                LIVE_RESERVATION_MARKER_PATTERN.source,
                LIVE_RESERVATION_MARKER_PATTERN.flags,
            ),
        ),
    ];
    if (matches.length === 0) {
        return null;
    }
    if (matches.length !== 1) {
        throw new Error('Live reservation marker must appear exactly once.');
    }
    try {
        return parseLiveMirrorReservationBinding(JSON.parse(matches[0]?.[1]?.trim() ?? ''));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error('Live reservation marker must contain valid JSON.', { cause: error });
        }
        throw error;
    }
}

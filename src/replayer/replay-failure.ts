/**
 * The typed failure of a replay run that never produced a verdict to grade.
 *
 * A replay run is a benchmark measurement: its rubric is only meaningful when the agent actually
 * submitted a verdict through the terminal tool. Every other seal — a provider failure, an
 * exhausted budget, a caller abort, terminal payloads rejected up to the cap, or a run that simply
 * never called the terminal tool — is an infrastructure ending, not an agent answer. Such a run
 * leaves this artifact instead of a graded comparison, so an outage can never be counted as a real
 * `cannot-reproduce` agreement.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { SealKind } from '../pi/seal-types';

/**
 * Why a replay run cannot be graded: the pi seal kind it ended on, minus the accepted terminal
 * verdict, which is the only gradeable ending.
 */
export type ReplayFailureReason = Exclude<SealKind, typeof SealKind.Terminal>;

/**
 * Every ReplayFailureReason value, for schemas and exhaustive listings.
 */
export const REPLAY_FAILURE_REASON_VALUES: ReplayFailureReason[] = Object.values(SealKind).filter(
    (kind): kind is ReplayFailureReason => kind !== SealKind.Terminal,
);

export const ReplayRunFailureSchema = v.object({
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    runId: v.pipe(v.string(), v.minLength(1)),
    reason: v.picklist(REPLAY_FAILURE_REASON_VALUES),
    detail: v.string(),
    traceOutcome: v.nullable(v.string()),
    tracePath: v.pipe(v.string(), v.minLength(1)),
});

/**
 * The persisted record of a replay run that ended without a gradeable verdict.
 */
export type ReplayRunFailure = v.InferOutput<typeof ReplayRunFailureSchema>;

/**
 * Filename suffix of the failure artifact. It shares the `replay-<issue>-<runId>` stem with the
 * graded comparison so both endings of one run sort together in the replays directory, and the
 * suffix keeps a not-gradeable run from ever being mistaken for a comparison.
 */
const FAILURE_ARTIFACT_SUFFIX = '-failure.json';

/**
 * JSON indentation of the persisted artifact, matching the run trace this stack writes beside it.
 */
const ARTIFACT_JSON_INDENT = 2;

/**
 * A replay run that sealed without an accepted verdict. Carries the typed failure so a caller can
 * record the ending — per issue, in a batch — without ever reaching the grader.
 */
export class ReplayNotGradeableError extends Error {
    /**
     * The typed failure, identical to the persisted artifact's content.
     */
    readonly failure: ReplayRunFailure;

    /**
     * Absolute path of the persisted failure artifact.
     */
    readonly artifactPath: string;

    constructor(failure: ReplayRunFailure, artifactPath: string) {
        super(
            `Replay of issue #${failure.issueNumber} is not gradeable: the run sealed as ` +
                `${failure.reason} (${failure.detail}). Failure artifact: ${artifactPath}`,
        );
        this.name = 'ReplayNotGradeableError';
        this.failure = failure;
        this.artifactPath = artifactPath;
    }
}

/**
 * Write the typed failure artifact for a replay run that cannot be graded.
 *
 * @param replaysDir - Directory the replay artifacts of this run are written to.
 * @param failure - The typed failure, validated before it is persisted.
 * @returns The written artifact path.
 */
export function writeReplayFailureArtifact(replaysDir: string, failure: ReplayRunFailure): string {
    const validated = v.parse(ReplayRunFailureSchema, failure);
    mkdirSync(replaysDir, { recursive: true });
    const artifactPath = join(
        replaysDir,
        `replay-${validated.issueNumber}-${validated.runId}${FAILURE_ARTIFACT_SUFFIX}`,
    );
    writeFileSync(
        artifactPath,
        `${JSON.stringify(validated, null, ARTIFACT_JSON_INDENT)}\n`,
        'utf8',
    );
    return artifactPath;
}

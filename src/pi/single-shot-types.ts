import type { BaseIssue, BaseSchema } from 'valibot';
import type { ReasoningEffort } from '../config/reasoning-effort';
import type { Logger } from '../logger/logger';
import type { SingleShotMessage } from './single-shot-input';
import type { TurnStopReason } from './stop-reason';
import type { CompletionUsage } from './usage-reporting';

/**
 * Contract types of the single-shot mechanism: result unions, call options, the completion
 * vocabulary, and the consumer-facing client boundary. Type-first concern — the runtime behavior
 * lives in `single-shot.ts`; this split keeps every file inside the repo's ~500-line module rule.
 * This module is the ONE origin of these names: `single-shot.ts` exports the two entry points
 * (`createSingleShotClient`, `runStructuredSingleShot`) and re-exports nothing, so every consumer
 * imports the vocabulary from here and no symbol has two reachable origins.
 *
 * Nothing here is a `@earendil-works/pi-ai` type, on purpose: analyzer, environment, validator and
 * benchmark code consumes these results, and re-exporting pi's `Usage` and `StopReason` made a
 * harness type change an application-wide type change. Token usage and stop reasons are app-owned
 * (the shared `CompletionUsage` in `./usage-reporting`, the shared `TurnStopReason` set in
 * `./stop-reason`) and mapped from pi's shapes at the boundary in `single-shot.ts`, which is the
 * only module that sees both.
 *
 * Both call paths return the SAME result union. The text path used to carry its own two-arm `Pi*`
 * union whose failure arm was this one with `usage` instead of `usages`, which meant a caller could
 * not write one handler for "the provider did not answer usably" and the metered client needed a
 * second branch to record a text call's usage.
 */

/**
 * Terminal kinds of one structured single-shot call.
 */
export const SingleShotResultKind = {
    /**
     * An attempt produced schema-valid JSON.
     */
    Parsed: 'parsed',

    /**
     * Every allowed attempt produced a reply that failed extraction or schema validation.
     */
    InvalidResult: 'invalid-result',

    /**
     * The completion itself ended without a usable reply (provider error, abort, length).
     */
    ProviderFailure: 'provider-failure',
} as const;

/**
 * SingleShotResultKind value.
 */
export type SingleShotResultKind = (typeof SingleShotResultKind)[keyof typeof SingleShotResultKind];

/**
 * A structured call that produced a validated value.
 */
export interface SingleShotParsed<T> {
    /**
     * Discriminator for the parsed variant.
     */
    kind: typeof SingleShotResultKind.Parsed;

    /**
     * Schema-validated output.
     */
    value: T;

    /**
     * Usage of every attempt, in order (a repaired call prices both attempts). One entry for the
     * text path, which makes exactly one attempt.
     */
    usages: CompletionUsage[];

    /**
     * Number of completion attempts made.
     */
    attempts: number;

    /**
     * Model id that produced the value.
     */
    model: string;
}

/**
 * A structured call whose replies never validated.
 */
export interface SingleShotInvalidResult {
    /**
     * Discriminator for the invalid-result variant.
     */
    kind: typeof SingleShotResultKind.InvalidResult;

    /**
     * Bounded description of the last extraction/validation failure.
     */
    detail: string;

    /**
     * Number of completion attempts made.
     */
    attempts: number;

    /**
     * Usage of every attempt, in order.
     */
    usages: CompletionUsage[];

    /**
     * Model id that produced the invalid replies.
     */
    model: string;
}

/**
 * A single-shot call the provider never answered usably.
 */
export interface SingleShotProviderFailure {
    /**
     * Discriminator for the provider-failure variant.
     */
    kind: typeof SingleShotResultKind.ProviderFailure;

    /**
     * The stop reason that ended the completion (`error`, `aborted`, `length`, ...).
     */
    stopReason: TurnStopReason;

    /**
     * The provider's own normalized error text when pi surfaced one; otherwise a description of the
     * stop reason.
     */
    message: string;

    /**
     * Usage of every attempt of the call, the failed one included: an attempted provider call is
     * always accounted for, so a failure can never leave the run's usage looking complete.
     */
    usages: CompletionUsage[];

    /**
     * Model id the call targeted.
     */
    model: string;
}

/**
 * Result of one structured single-shot call; never throws for model/provider behavior.
 */
export type SingleShotResult<T> =
    | SingleShotParsed<T>
    | SingleShotInvalidResult
    | SingleShotProviderFailure;

/**
 * Options shared by both single-shot call paths.
 */
export interface SingleShotCallOptions {
    /**
     * Caller-authored messages; system entries merge after the schema contract (structured path) or
     * form the system prompt (text path).
     */
    messages: SingleShotMessage[];

    /**
     * Sampling temperature; defaults to 0 (every migrated consumer ran at 0 or unset).
     */
    temperature?: number;

    /**
     * Optional output-token cap. Uncapped by default: reasoning shares the completion budget, and a
     * cap that reasoning exhausts truncates the JSON while recording success.
     */
    maxTokens?: number;

    /**
     * Per-request HTTP deadline in milliseconds (mapped from `llm.requestTimeoutMs`).
     */
    timeoutMs?: number;

    /**
     * SDK-level transport retries per request, derived once from the configured attempt bound by
     * `providerMaxRetries` in `./llm-wiring` (`llm.requestMaxAttempts - 1`); the bespoke backoff
     * semantics retired with the legacy provider.
     */
    maxRetries?: number;

    /**
     * Reasoning effort for this call, overriding the bound client's default (mapped from
     * `llm.reasoningEffort` at the wiring sites). `off` — and an absent value — sends no reasoning
     * parameter. It reaches the wire only for a model registered `reasoning: true`, so it is inert
     * on a client bound to the vision model and live on one bound to a reasoning model.
     */
    reasoningEffort?: ReasoningEffort;

    /**
     * Caller cancellation; an aborted request ends as a provider-failure with `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Diagnostics sink for one structured warn on each terminal failure.
     */
    logger?: Logger;
}

/**
 * Options for one structured single-shot call.
 */
export interface SingleShotStructuredOptions<T> extends SingleShotCallOptions {
    /**
     * Valibot schema that owns the accepted reply fields.
     */
    schema: BaseSchema<unknown, T, BaseIssue<unknown>>;

    /**
     * Schema-validation attempts owned by this call, 1..3; default 2 (initial + one repair).
     */
    maxAttempts?: number;
}

/**
 * The consumer-facing single-shot boundary: one bound model, two call paths, no pi types.
 */
export interface SingleShotClient {
    /**
     * The bound model id (consumers persist/return it as they did the configured slug).
     */
    readonly modelId: string;

    /**
     * Run one schema-validated structured call with bounded repair.
     *
     * @param options - Messages, schema, and call controls.
     * @returns The typed result union; model/provider misbehavior never throws.
     */
    structured<T>(options: SingleShotStructuredOptions<T>): Promise<SingleShotResult<T>>;

    /**
     * Run one free-text completion (the golden oracle's screenshot descriptions).
     *
     * @param options - Messages and call controls.
     * @returns The shared result union with the reply as its value; `invalid-result` cannot occur
     *   on this path, which validates nothing.
     */
    text(options: SingleShotCallOptions): Promise<SingleShotResult<string>>;
}

/**
 * Defaults applied to every call of one bound client.
 */
export interface SingleShotClientDefaults {
    /**
     * Completion cap put on the wire (`max_completion_tokens`) for every call of this client unless
     * a call passes its own. Without it a single-shot request carries no cap at all and the
     * provider applies its own default, which a reasoning model's thinking exhausts before the
     * answer: a live vision verdict ended `length` that way.
     */
    maxTokens?: number;

    /**
     * Per-request HTTP deadline in milliseconds.
     */
    timeoutMs?: number;

    /**
     * SDK-level transport retries per request.
     */
    maxRetries?: number;

    /**
     * Reasoning effort applied to every call of this client, mapped from `llm.reasoningEffort` by
     * `createConfiguredSingleShotClient`; a call may override it.
     */
    reasoningEffort?: ReasoningEffort;

    /**
     * Diagnostics sink used when the call options carry none.
     */
    logger?: Logger;
}

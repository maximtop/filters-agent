import { randomUUID } from 'node:crypto';
import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';
import {
    contentText,
    type Api,
    type AssistantMessage,
    type Message,
    type Model,
} from '@earendil-works/pi-ai';
import { ReasoningEffort, type ActiveReasoningEffort } from '../config/reasoning-effort';
import {
    SingleShotResultKind,
    type SingleShotCallOptions,
    type SingleShotClient,
    type SingleShotClientDefaults,
    type SingleShotResult,
    type SingleShotStructuredOptions,
} from './single-shot-types';
import type { PiRuntime } from './runtime';
import { toPiMessages } from './single-shot-input';
import { toTurnStopReason, TurnStopReason } from './stop-reason';
import { toCompletionUsage, type CompletionUsage } from './usage-reporting';
import { formatIssues } from './valibot-issues';

/**
 * Single-shot LLM calls on the pi runtime: every out-of-loop completion (vision verdicts,
 * inventories, screenshot analysis, benchmark reviewer, golden oracle) runs through this module.
 * One structured mechanism — prompt-and-parse with one bounded repair attempt, ported verbatim in
 * semantics from the retired vision-json adapter — serves them all, and the free-text path is the
 * same mechanism with no schema. Model/provider behavior never throws here: results are typed
 * unions, terminal failures emit one structured pino warn through the injected logger (pi exposes
 * no retry events, so this line is the only failure diagnostic a run sees), and programmer errors
 * still throw. This module is also the single-shot boundary between pi's vocabulary and the
 * application's own: pi's `Usage` and `StopReason` are mapped here into the shared
 * `CompletionUsage` and `TurnStopReason`, so nothing a consumer of these results touches is a
 * harness type.
 *
 * The contract types live in `single-shot-types.ts` and are imported FROM there by every consumer;
 * this module re-exports none of them. It used to, next to the behavior, and the result was two
 * reachable origins for one symbol — the split leaked into call sites either way, and one origin
 * per name is the property worth keeping.
 */

/**
 * Maximum schema bytes embedded in one structured system contract.
 *
 * Same bound the retiring vision-json adapter enforced; larger schemas belong in the agent loop's
 * terminal tool, not in an embedded contract.
 */
const MAX_SCHEMA_CHARS = 16_000;

/**
 * Maximum invalid model reply retained on the repair re-prompt.
 *
 * Same bound as the retiring adapter: enough for the model to see its mistake, small enough to keep
 * the repair turn cheap.
 */
const MAX_INVALID_RESPONSE_CHARS = 8_000;

/**
 * Maximum validation diagnostic carried by the repair prompt and the typed failure.
 */
const MAX_VALIDATION_DETAIL_CHARS = 1_000;

/**
 * Smallest structured-validation attempt count one logical call may own.
 *
 * Why 1 and not 2: a caller whose own loop owns repair (the validator's final synthesis) re-prompts
 * with context this function does not have, and a repair attempt inside the call would pay for a
 * second completion that the outer loop is about to make redundant. Zero is not a call at all.
 */
const MIN_MAX_ATTEMPTS = 1;

/**
 * Largest structured-validation attempt count one logical call may own.
 *
 * Why 3: the ceiling of the retiring vision-json adapter's `1 through 3` contract, ported so no
 * migrated caller changes behaviour. The working default is 2 — initial plus one repair — and no
 * caller in the tree passes more; the ceiling exists to stop `maxAttempts` from turning ONE logical
 * single-shot call into an unbounded repair loop, because every attempt past the first is another
 * paid completion and a model that has already seen its own schema error twice is not converging. A
 * caller that genuinely needs more re-prompts from its own loop with context this function does not
 * have.
 */
const MAX_MAX_ATTEMPTS = 3;

/**
 * Sampling temperature applied when a call passes none.
 *
 * Every migrated structured path ran at explicit 0 (vision-json, reviewer, oracle); the screenshot
 * tool left it unset, which let the gateway default decide — 0 keeps it deterministic and matches
 * the dominant existing behavior.
 */
const DEFAULT_TEMPERATURE = 0;

/**
 * Maximum Valibot issues quoted in one bounded diagnostic.
 *
 * A reply that misses the schema usually misses it in one or two places; a reply that misses it in
 * more than eight is the wrong shape entirely, and listing the rest tells the model nothing it does
 * not already learn from the first few. The cap also keeps the repair prompt cheap before the
 * character bound has to cut a line mid-word.
 */
const MAX_VALIDATION_DETAIL_ISSUES = 8;

/**
 * Render a bounded validation failure without echoing image data or credentials.
 *
 * @param error - Parsing or schema-validation failure.
 * @returns Safe bounded diagnostic for one repair attempt and the typed failure.
 */
function validationDetail(error: unknown): string {
    if (error instanceof v.ValiError) {
        return formatIssues(error.issues.slice(0, MAX_VALIDATION_DETAIL_ISSUES)).slice(
            0,
            MAX_VALIDATION_DETAIL_CHARS,
        );
    }
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_VALIDATION_DETAIL_CHARS,
    );
}

/**
 * Extract one JSON value from a model reply that may include a Markdown fence or prose.
 *
 * @param content - Raw assistant reply.
 * @returns Parsed JSON value.
 */
function parseJsonResponse(content: string): unknown {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    if (fenced?.[1]) {
        return JSON.parse(fenced[1]);
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        }
        throw new Error('response did not contain a JSON object');
    }
}

/**
 * Map the configured reasoning effort onto the provider request field, or onto nothing.
 *
 * The pi boundary in one place. Single-shot calls go through `ModelRuntime.complete`, which is the
 * API-typed path (`stream`), so the field pi reads is `reasoningEffort` — `reasoning` is the
 * `streamSimple`-only spelling that pi clamps before forwarding under this same name, and passing
 * it here would be silently dropped. That path applies no clamping and has no `off` member: "off"
 * is expressed by omitting the field, which for a model with no `thinkingLevelMap` (ours) is what
 * makes pi send no `reasoning_effort` at all. The remaining literals are pi's own, so no lookup
 * table stands between the configuration and the wire.
 *
 * @param effort - The configured effort, or undefined when neither the call nor the client set one.
 * @returns The request fields to spread, empty for `off` and for an unset effort.
 */
function reasoningEffortRequestFields(effort: ReasoningEffort | undefined): {
    /**
     * The level pi puts on the wire as `reasoning_effort`; absent means no reasoning parameter.
     */
    reasoningEffort?: ActiveReasoningEffort;
} {
    return effort === undefined || effort === ReasoningEffort.Off
        ? {}
        : { reasoningEffort: effort };
}

/**
 * Run one completion through the pi runtime and return the raw assistant message.
 *
 * @param runtime - The pi runtime the model handle belongs to.
 * @param model - Model handle to call.
 * @param systemPrompt - Optional system prompt.
 * @param messages - Pi message list.
 * @param options - Call controls, including the cache-routing session id.
 * @returns The raw assistant message (pi resolves provider failures instead of throwing).
 */
async function completeOnce(
    runtime: PiRuntime,
    model: Model<Api>,
    systemPrompt: string | undefined,
    messages: Message[],
    options: Omit<SingleShotCallOptions, 'messages'> & {
        /**
         * One affinity id per logical call, routing cache reads within it.
         */
        sessionId?: string;
    },
): Promise<AssistantMessage> {
    return runtime.modelRuntime.complete(
        model,
        { ...(systemPrompt !== undefined ? { systemPrompt } : {}), messages },
        {
            temperature: options.temperature ?? DEFAULT_TEMPERATURE,
            ...reasoningEffortRequestFields(options.reasoningEffort),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
    );
}

/**
 * Rebuild a replied assistant message for the repair turn: thinking blocks verbatim (thinking
 * gateways match and require them), text bounded so an enormous invalid reply stays cheap.
 *
 * @param message - The assistant message whose reply failed validation.
 * @returns The bounded history entry.
 */
function boundedAssistantReplay(message: AssistantMessage): AssistantMessage {
    return {
        ...message,
        content: [
            ...message.content.filter((block) => block.type === 'thinking'),
            {
                type: 'text',
                text: contentText(message.content).slice(0, MAX_INVALID_RESPONSE_CHARS),
            },
        ],
    };
}

/**
 * Run one structured single-shot call with bounded repair.
 *
 * @param runtime - The pi runtime to call through.
 * @param model - Bound model handle.
 * @param options - Messages, schema, and call controls.
 * @returns The typed result union.
 */
export async function runStructuredSingleShot<T>(
    runtime: PiRuntime,
    model: Model<Api>,
    options: SingleShotStructuredOptions<T>,
): Promise<SingleShotResult<T>> {
    const schemaJson = JSON.stringify(toJsonSchema(options.schema));
    if (schemaJson.length > MAX_SCHEMA_CHARS) {
        throw new Error(`Vision JSON Schema exceeds ${MAX_SCHEMA_CHARS} characters`);
    }
    const maxAttempts = options.maxAttempts ?? 2;
    if (
        !Number.isInteger(maxAttempts) ||
        maxAttempts < MIN_MAX_ATTEMPTS ||
        maxAttempts > MAX_MAX_ATTEMPTS
    ) {
        throw new Error(
            `Vision JSON maxAttempts must be an integer from ${MIN_MAX_ATTEMPTS} through ` +
                `${MAX_MAX_ATTEMPTS}`,
        );
    }
    const contract = [
        'Return only one valid JSON object with no Markdown or prose.',
        'It must match this JSON Schema exactly. Do not add fields or replace arrays/objects',
        `with counts or confidence scores. JSON Schema: ${schemaJson}`,
    ].join(' ');
    const converted = await toPiMessages(options.messages);
    const systemPrompt = [contract, converted.systemPrompt].filter(Boolean).join('\n\n');
    // One affinity id per logical call routes the repair request to the replica holding the
    // prefix cache of the first attempt.
    const sessionId = randomUUID();
    let messages = converted.messages;
    const usages: CompletionUsage[] = [];
    let lastFailure = 'unknown validation failure';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const message = await completeOnce(runtime, model, systemPrompt, messages, {
            ...options,
            sessionId,
        });
        if (message.stopReason !== TurnStopReason.Stop) {
            // Account for the attempt before returning: a provider call that failed is still a
            // provider call, and dropping it let a run whose last call failed report COMPLETE
            // usage on the strength of the calls that happened to succeed.
            usages.push(toCompletionUsage(model.id, message.usage));
            const failureMessage =
                message.errorMessage ??
                `pi completion ended with stop reason "${message.stopReason}"`;
            options.logger?.warn(
                {
                    kind: SingleShotResultKind.ProviderFailure,
                    stopReason: message.stopReason,
                    message: failureMessage,
                    attempts: attempt,
                    model: model.id,
                },
                'single-shot LLM call failed: provider or daemon error',
            );
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: toTurnStopReason(message.stopReason),
                message: failureMessage,
                usages,
                model: model.id,
            };
        }
        usages.push(toCompletionUsage(model.id, message.usage));
        try {
            return {
                kind: SingleShotResultKind.Parsed,
                value: v.parse(options.schema, parseJsonResponse(contentText(message.content))),
                usages,
                attempts: attempt,
                model: model.id,
            };
        } catch (error) {
            lastFailure = validationDetail(error);
            if (attempt === maxAttempts) {
                break;
            }
            messages = [
                ...messages,
                boundedAssistantReplay(message),
                {
                    role: 'user',
                    content:
                        'The previous JSON did not match the required schema: ' +
                        `${lastFailure}. Return a corrected JSON object only.`,
                    timestamp: Date.now(),
                },
            ];
        }
    }
    options.logger?.warn(
        {
            kind: SingleShotResultKind.InvalidResult,
            detail: lastFailure,
            attempts: maxAttempts,
            model: model.id,
        },
        'single-shot LLM call failed: no schema-valid reply after bounded repair attempts',
    );
    return {
        kind: SingleShotResultKind.InvalidResult,
        detail: lastFailure,
        attempts: maxAttempts,
        usages,
        model: model.id,
    };
}

/**
 * Bind one model handle into the consumer-facing single-shot client.
 *
 * @param runtime - The pi runtime the handle belongs to.
 * @param model - Bound model handle (typically `PiRuntime.visionModel`).
 * @param defaults - Call defaults mapped from `CoreConfig.llm` at the wiring sites.
 * @returns The two-method consumer boundary.
 */
export function createSingleShotClient(
    runtime: PiRuntime,
    model: Model<Api>,
    defaults: SingleShotClientDefaults = {},
): SingleShotClient {
    return {
        modelId: model.id,
        structured: <T>(options: SingleShotStructuredOptions<T>) =>
            runStructuredSingleShot(runtime, model, {
                timeoutMs: defaults.timeoutMs,
                maxRetries: defaults.maxRetries,
                maxTokens: defaults.maxTokens,
                reasoningEffort: defaults.reasoningEffort,
                logger: defaults.logger,
                ...options,
            }),
        text: async (options: SingleShotCallOptions): Promise<SingleShotResult<string>> => {
            const converted = await toPiMessages(options.messages);
            const message = await completeOnce(
                runtime,
                model,
                converted.systemPrompt,
                converted.messages,
                {
                    timeoutMs: defaults.timeoutMs,
                    maxRetries: defaults.maxRetries,
                    maxTokens: defaults.maxTokens,
                    reasoningEffort: defaults.reasoningEffort,
                    ...options,
                },
            );
            const usages = [toCompletionUsage(model.id, message.usage)];
            if (message.stopReason === TurnStopReason.Stop) {
                return {
                    kind: SingleShotResultKind.Parsed,
                    value: contentText(message.content),
                    usages,
                    attempts: 1,
                    model: model.id,
                };
            }
            const failureMessage =
                message.errorMessage ??
                `pi completion ended with stop reason "${message.stopReason}"`;
            const failureLogger = options.logger ?? defaults.logger;
            failureLogger?.warn(
                {
                    kind: SingleShotResultKind.ProviderFailure,
                    stopReason: message.stopReason,
                    message: failureMessage,
                    attempts: 1,
                    model: model.id,
                },
                'single-shot LLM call failed: provider or daemon error',
            );
            return {
                kind: SingleShotResultKind.ProviderFailure,
                stopReason: toTurnStopReason(message.stopReason),
                message: failureMessage,
                // The attempt is reported like a successful one so the metered client can record
                // it; without this a failed text call left no trace in the run's usage at all.
                usages,
                model: model.id,
            };
        },
    };
}

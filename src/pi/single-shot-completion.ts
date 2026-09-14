import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { ReasoningEffort, type ActiveReasoningEffort } from '../config/reasoning-effort';
import type { SingleShotCallOptions } from './single-shot-types';
import type { PiRuntime } from './runtime';

/**
 * One bounded provider completion for the single-shot mechanism: the pi request mapping (sampling,
 * reasoning effort, caps, retries, cache affinity) and the INACTIVITY bound over the streamed
 * response. `single-shot.ts` owns the structured repair loop and the consumer-facing client and
 * calls exactly this for every attempt it makes.
 *
 * Split out of `single-shot.ts` because the stall bound is a second responsibility with its own
 * vocabulary — the stream, its events and the abort composed from two sources — and because both
 * modules stay inside the repo's ~500-line rule that way.
 *
 * Why an inactivity bound at all: `timeoutMs` reaches the OpenAI SDK as its `timeout`, and the SDK
 * clears that timer in a `finally` the moment the response resolves — that is, when the HEADERS
 * arrive. Nothing below bounds the streamed body for openai-completions, so a gateway that opened a
 * stream and then stopped producing left a single-shot call unbounded. Live run 34876679458
 * (2026-09-13) called `inspect_full_page_capture` at 18:33:36Z and logged nothing until 19:17:29Z,
 * when the gateway's OWN idle timeout ended the stalled stream 44 minutes later with `Upstream idle
 * timeout exceeded`; the run's 60-minute wall-clock guard could not take effect until then and the
 * job ran 90 minutes. The agent loop already bounds exactly this half in `run-guards.ts`, armed on
 * the assistant `message_start` and re-armed on every `message_update`; this is the same bound for
 * the out-of-loop calls, arming on the stream's first event and re-arming on each one after it.
 */

/**
 * Sampling temperature applied when a call passes none.
 *
 * Every migrated structured path ran at explicit 0 (vision-json, reviewer, oracle); the screenshot
 * tool left it unset, which let the gateway default decide — 0 keeps it deterministic and matches
 * the dominant existing behavior.
 */
const DEFAULT_TEMPERATURE = 0;

/**
 * Map the configured reasoning effort onto the provider request field, or onto nothing.
 *
 * The pi boundary in one place. Single-shot calls go through the API-typed streaming path, so the
 * field pi reads is `reasoningEffort` — `reasoning` is the `streamSimple`-only spelling that pi
 * clamps before forwarding under this same name, and passing it here would be silently dropped.
 * That path applies no clamping and has no `off` member: "off" is expressed by omitting the field,
 * which for a model with no `thinkingLevelMap` (ours) is what makes pi send no `reasoning_effort`
 * at all. The remaining literals are pi's own, so no lookup table stands between the configuration
 * and the wire.
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
 * Describe the stall that ended one streamed completion, for the typed failure and its log line.
 *
 * The provider's own text is kept beside it: the abort is ours, so pi reports only "Request was
 * aborted", and a failure whose whole diagnosis is a bare code is what this codebase forbids.
 *
 * @param stallBoundMs - The inactivity bound the stream exceeded.
 * @param streamedEvents - Progress events the stream produced before it went silent, so a
 *   post-mortem can tell a stream that stalled on its first token from one that stalled mid-reply.
 * @param providerMessage - Pi's own error text for the aborted request, when it carried one.
 * @returns The single-line failure message naming the stall.
 */
function stallMessage(
    stallBoundMs: number,
    streamedEvents: number,
    providerMessage: string | undefined,
): string {
    const stall =
        `single-shot stream made no streamed progress for ${stallBoundMs}ms ` +
        `(${streamedEvents} streamed events before the stall)`;
    return providerMessage === undefined ? stall : `${stall}: ${providerMessage}`;
}

/**
 * Options one bounded completion takes beyond the messages it sends.
 */
export type SingleShotCompletionOptions = Omit<SingleShotCallOptions, 'messages'> & {
    /**
     * One affinity id per logical call, routing cache reads within it.
     */
    sessionId?: string;
};

/**
 * Run one completion through the pi runtime and return the raw assistant message.
 *
 * The response is bounded in two halves, both from `options.timeoutMs`: up to the headers by the
 * SDK's own `timeout`, and from there to the end of the assistant message by the inactivity
 * deadline armed here. The deadline aborts the request, which pi resolves into an `aborted`
 * assistant message; the returned message then names the stall so the caller's existing
 * provider-failure path reports and logs it without a second failure shape. A caller abort still
 * wins: its message is returned exactly as pi produced it.
 *
 * @param runtime - The pi runtime the model handle belongs to.
 * @param model - Model handle to call.
 * @param systemPrompt - Optional system prompt.
 * @param messages - Pi message list.
 * @param options - Call controls, including the cache-routing session id.
 * @returns The raw assistant message (pi resolves provider failures instead of throwing).
 */
export async function completeOnce(
    runtime: PiRuntime,
    model: Model<Api>,
    systemPrompt: string | undefined,
    messages: Message[],
    options: SingleShotCompletionOptions,
): Promise<AssistantMessage> {
    const stallBoundMs = options.timeoutMs;
    // Composed before the request: the signal has to be in the options pi builds the request from.
    const stallController = new AbortController();
    const sources = [
        ...(options.signal === undefined ? [] : [options.signal]),
        ...(stallBoundMs === undefined ? [] : [stallController.signal]),
    ];
    const signal = sources.length === 0 ? undefined : AbortSignal.any(sources);
    const stream = runtime.modelRuntime.stream(
        model,
        { ...(systemPrompt !== undefined ? { systemPrompt } : {}), messages },
        {
            temperature: options.temperature ?? DEFAULT_TEMPERATURE,
            ...reasoningEffortRequestFields(options.reasoningEffort),
            ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
            ...(stallBoundMs !== undefined ? { timeoutMs: stallBoundMs } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
            ...(signal !== undefined ? { signal } : {}),
        },
    );
    if (stallBoundMs === undefined) {
        // No configured deadline, so there is no bound to arm; `result()` is what `complete()` is.
        return await stream.result();
    }
    let stalled = false;
    let streamedEvents = 0;
    let timer: NodeJS.Timeout | undefined;
    const armStallTimer = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            stalled = true;
            stallController.abort();
        }, stallBoundMs);
        timer.unref();
    };
    try {
        armStallTimer();
        // Every event is a sign of life — a text or thinking delta, a tool-call delta, the stream's
        // own start — so the deadline measures the gap since the last one and never the response's
        // total length: a model that streams its reasoning for many minutes is alive. The terminal
        // `done`/`error` event is the ending rather than progress, so only the events ahead of it
        // are counted for the stall diagnostic.
        for await (const event of stream) {
            if (event.type !== 'done' && event.type !== 'error') {
                streamedEvents += 1;
            }
            armStallTimer();
        }
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
    const message = await stream.result();
    return stalled && options.signal?.aborted !== true
        ? {
              ...message,
              errorMessage: stallMessage(stallBoundMs, streamedEvents, message.errorMessage),
          }
        : message;
}

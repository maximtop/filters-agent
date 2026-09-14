import { InMemoryCredentialStore, type Api, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LlmConfig } from '../config/config';

/**
 * Pi runtime setup: turn application provider configuration into a ready pi model runtime — an
 * OpenAI-compatible provider registered entirely in code over the OpenAI-completions API,
 * credentials held in an in-memory store, both model handles resolved, compatibility flags
 * applied.
 */

/**
 * Provider id the configured OpenAI-compatible gateway is registered under inside the pi runtime.
 */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

/**
 * Explicit zero rates registered with every catalog entry.
 *
 * Pi derives `Usage.cost` from these rates and this layer never reads that field: run cost is
 * priced by `usage-collector.ts` from the tracked, digest-pinned rate table, because a cost figure
 * is only comparable across runs when every run priced the same way. Zeroes are what pi is told, so
 * nothing can quietly start reporting a fabricated in-catalog price instead.
 */
const UNPRICED_MODEL_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * OpenAI-completions compatibility flags for the configured gateway, applied to every registered
 * model.
 *
 * `requiresReasoningContentOnAssistantMessages` replays `reasoning_content` on assistant history:
 * some thinking-mode OpenAI-compatible gateways hard-fail the following request without it (the
 * bespoke loop carried the same workaround). pi's URL auto-detection cannot fire here — the gateway
 * host is not `deepseek.com` — so the flag must be explicit, and it only takes effect on entries
 * registered with `reasoning: true`.
 *
 * `sendSessionAffinityHeaders` with `sessionAffinityFormat: 'openai'` attaches `session_id`,
 * `x-client-request-id`, and `x-session-affinity` headers whenever a caller passes a session id,
 * which is how the gateway routes one session to a warm prompt-cache replica.
 *
 * `supportsDeveloperRole: false` keeps the system prompt under the `system` role. Pi's
 * openai-completions API sends it as `developer` for any entry registered `reasoning: true` unless
 * the flag says otherwise, and its URL auto-detection only turns the role off for hosts it knows
 * (`deepseek.com`, `cerebras.ai`, …) — the gateway host is none of them, so the detected default is
 * `true`. The gateway's upstream pool is not uniform on that role: in one live campaign a replica
 * answered 400 "messages[0].role: unknown variant developer, expected one of system, user,
 * assistant, tool" on the 26th request of a session whose first 25 requests — same model, same
 * system prompt, same role — had been accepted by other replicas, and the run sealed
 * `provider-failure` as a deterministic rejection. `system` is the one spelling every OpenAI-shaped
 * upstream accepts, and the two roles are equivalent to the gateway, so nothing is given up by
 * pinning it.
 */
const OPENAI_COMPATIBLE_COMPAT = {
    requiresReasoningContentOnAssistantMessages: true,
    sendSessionAffinityHeaders: true,
    sessionAffinityFormat: 'openai',
    supportsDeveloperRole: false,
} as const;

/**
 * The provider registration shape accepted by `ModelRuntime.registerProvider`.
 *
 * Pi-coding-agent's public index does not re-export `ProviderConfigInput`, so the type is lifted
 * from the method signature (the same trick the knowledge-base runtime uses).
 */
type ProviderRegistration = Parameters<ModelRuntime['registerProvider']>[1];

/**
 * Provider configuration the pi runtime setup consumes: the slice of `CoreConfig.llm` that
 * describes the gateway and the two models registered against it.
 *
 * Taken directly, not re-validated: `loadCoreConfig` already enforced this shape at the environment
 * boundary and `createPiRuntimeFromConfig` hands over exactly that validated value, so a second
 * check here could only ever pass.
 */
export type PiRuntimeConfig = Pick<
    LlmConfig,
    | 'baseUrl'
    | 'apiKey'
    | 'model'
    | 'visionModel'
    | 'contextWindowTokens'
    | 'maxOutputTokens'
    | 'visionMaxOutputTokens'
>;

/**
 * Thrown when a model id does not resolve on this runtime's provider catalog.
 *
 * A lookup failure, not a configuration one — the configuration was validated at the env boundary
 * and this runtime never re-checks it. The message still names the field that carried the id (`-
 * model: ...`), mirroring `ConfigError`, so a broken setup is diagnosable in one read and never
 * surfaces as a bare stack.
 */
export class PiModelLookupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PiModelLookupError';
    }
}

/**
 * A configured, app-owned pi runtime: provider registered in code, credentials in memory, both
 * model handles resolved.
 */
export interface PiRuntime {
    /**
     * The underlying pi model runtime every agent session and single-shot call is built on.
     */
    modelRuntime: ModelRuntime;

    /**
     * Resolved reasoning-model handle (`PiRuntimeConfig.model`).
     */
    reasoningModel: Model<Api>;

    /**
     * Resolved vision-model handle (`PiRuntimeConfig.visionModel`).
     */
    visionModel: Model<Api>;
}

/**
 * Register one extra text-only reasoning model on the configured OpenAI-compatible provider and
 * resolve it.
 *
 * The benchmark reviewer's model override (`reviewerModel`, defaulting to the configured reasoning
 * model) may name a slug outside the two configured models; the legacy provider sent any slug to
 * the gateway, so the pi runtime keeps that capability by extending the in-code catalog.
 * Idempotent: an already-registered id resolves without re-registering.
 *
 * The new entry inherits the resolved reasoning model's catalog limits — it stands in for exactly
 * that role — so an override model is bounded by the configured values and no second default for
 * either limit exists anywhere in this layer.
 *
 * @param runtime - The runtime whose provider catalog is extended.
 * @param modelId - The additional model id served by the gateway.
 * @returns The resolved model handle.
 */
export function registerAdditionalTextModel(runtime: PiRuntime, modelId: string): Model<Api> {
    const existing = runtime.modelRuntime.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, modelId);
    if (existing) {
        return existing;
    }
    const registration = runtime.modelRuntime.getRegisteredProviderConfig(
        OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    if (!registration) {
        throw new PiModelLookupError(
            `Invalid pi runtime configuration:\n  - model: provider ${OPENAI_COMPATIBLE_PROVIDER_ID} ` +
                'is not registered on this runtime',
        );
    }
    runtime.modelRuntime.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, {
        ...registration,
        models: [
            ...(registration.models ?? []),
            {
                id: modelId,
                name: modelId,
                reasoning: true,
                input: ['text'],
                cost: { ...UNPRICED_MODEL_COST },
                contextWindow: runtime.reasoningModel.contextWindow,
                maxTokens: runtime.reasoningModel.maxTokens,
                compat: { ...OPENAI_COMPATIBLE_COMPAT },
            },
        ],
    });
    return resolveModel(runtime.modelRuntime, modelId, 'model');
}

/**
 * Build the catalog entries for the configured reasoning and vision models.
 *
 * Every limit is configuration, not folklore: pi acts on them on every request — `contextWindow` is
 * the number its auto-compaction threshold (`contextWindow − reserveTokens`) is measured against,
 * and `maxTokens` is sent as `max_completion_tokens`, clamped to what is left of the window. The
 * completion cap is per ROLE, because the two roles are bounded by different things: the loop model
 * spends the same budget on thinking and on the terminal payload that follows it, while a vision
 * call returns one bounded JSON verdict. All three values are required configuration, defaulted
 * once in `config.ts` — see the constants there for the numbers and where they come from.
 *
 * @param config - Validated provider configuration.
 * @returns Both model entries with their configured limits and the shared compat flags.
 */
function openAiCompatibleModels(
    config: PiRuntimeConfig,
): NonNullable<ProviderRegistration['models']> {
    const shared = {
        cost: { ...UNPRICED_MODEL_COST },
        contextWindow: config.contextWindowTokens,
        compat: { ...OPENAI_COMPATIBLE_COMPAT },
    };
    return [
        {
            ...shared,
            id: config.model,
            name: config.model,
            reasoning: true,
            input: ['text'],
            maxTokens: config.maxOutputTokens,
        },
        {
            ...shared,
            id: config.visionModel,
            name: config.visionModel,
            reasoning: false,
            input: ['text', 'image'],
            maxTokens: config.visionMaxOutputTokens,
        },
    ];
}

/**
 * Resolve one registered model handle, or fail naming the configuration field that selected it.
 *
 * @param modelRuntime - The runtime the provider was registered on.
 * @param modelId - Model id to resolve.
 * @param field - Configuration field that carried the id.
 * @returns The resolved model handle.
 */
function resolveModel(modelRuntime: ModelRuntime, modelId: string, field: string): Model<Api> {
    const model = modelRuntime.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, modelId);
    if (!model) {
        throw new PiModelLookupError(
            `Invalid pi runtime configuration:\n  - ${field}: model is not registered ` +
                `with the ${OPENAI_COMPATIBLE_PROVIDER_ID} provider`,
        );
    }
    return model;
}

/**
 * Turn validated provider configuration into a ready pi model runtime.
 *
 * `modelsPath: null` plus the `InMemoryCredentialStore` guarantee nothing is read from or written
 * to any home-directory pi configuration, and `ModelRuntime.create` performs no network access (its
 * model-network flag defaults off), so setup is safe to run anywhere.
 *
 * @param config - Provider fields (typically `CoreConfig.llm`).
 * @returns The runtime with both model handles resolved.
 */
export async function createPiRuntime(config: PiRuntimeConfig): Promise<PiRuntime> {
    const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        credentials: new InMemoryCredentialStore(),
    });
    modelRuntime.registerProvider(OPENAI_COMPATIBLE_PROVIDER_ID, {
        name: 'OpenAI-compatible',
        baseUrl: config.baseUrl,
        api: 'openai-completions',
        models: openAiCompatibleModels(config),
    });
    await modelRuntime.setRuntimeApiKey(OPENAI_COMPATIBLE_PROVIDER_ID, config.apiKey);
    return {
        modelRuntime,
        reasoningModel: resolveModel(modelRuntime, config.model, 'model'),
        visionModel: resolveModel(modelRuntime, config.visionModel, 'visionModel'),
    };
}

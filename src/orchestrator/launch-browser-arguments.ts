/**
 * The `launch_browser` tool argument vocabulary: the strict Valibot shapes the runtime validates a
 * launch request against, and the two compatibility readers that run before that validation.
 *
 * It is deliberately separate from the runtime class. Nothing here touches runtime state, so a
 * launch argument shape can be read and exercised without constructing a browser session.
 */
import * as v from 'valibot';
import { CONSENT_STRATEGY_VALUES, VIEWPORT_VALUES } from '../types/repro-profile';
import { SettingsProfileKind } from '../types/settings-profile-kind';

const AgentSelectedSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.AgentSelected),
    filterIds: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    stealthEnabled: v.boolean(),
});

const DefaultsSettingsSchema = v.strictObject({
    kind: v.literal(SettingsProfileKind.DefaultsPlusRequired),
    requiredFilterIds: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
    reporterImportUrl: v.optional(v.pipe(v.string(), v.url())),
    siteHostname: v.optional(v.string()),
    reportedFilterNames: v.optional(v.array(v.string())),
    issueLabels: v.optional(v.array(v.string())),
});

const ReportSettingsSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal(SettingsProfileKind.ReportExact),
        importUrl: v.pipe(v.string(), v.url()),
    }),
    v.strictObject({
        kind: v.literal(SettingsProfileKind.ReportedOnCurrent),
        importUrl: v.pipe(v.string(), v.url()),
    }),
]);

const AgentBrowserProfileSchema = v.strictObject({
    viewport: v.picklist(VIEWPORT_VALUES),
    locale: v.pipe(v.string(), v.minLength(2), v.maxLength(35)),
    timezone: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    consentStrategy: v.picklist(CONSENT_STRATEGY_VALUES),
    geolocation: v.optional(
        v.strictObject({
            latitude: v.pipe(v.number(), v.minValue(-90), v.maxValue(90)),
            longitude: v.pipe(v.number(), v.minValue(-180), v.maxValue(180)),
        }),
    ),
});

export const LaunchBrowserSchema = v.variant('extension', [
    v.strictObject({
        extension: v.literal('none'),
        targetUrl: v.pipe(v.string(), v.url()),
        profile: AgentBrowserProfileSchema,
    }),
    v.strictObject({
        extension: v.literal('prepared'),
        targetUrl: v.pipe(v.string(), v.url()),
        profile: AgentBrowserProfileSchema,
        settings: v.union([
            AgentSelectedSettingsSchema,
            DefaultsSettingsSchema,
            ReportSettingsSchema,
        ]),
    }),
]);

/**
 * Maximum encoded profile size accepted for the narrow model-output compatibility path.
 */
const MAX_ENCODED_BROWSER_PROFILE_LENGTH = 4_096;

/**
 * Maximum validation detail returned to the model for a malformed browser launch request.
 */
export const MAX_BROWSER_VALIDATION_DETAIL_LENGTH = 1_000;

/**
 * Exact own keys accepted on a model-selected browser profile.
 */
const AGENT_BROWSER_PROFILE_KEYS = new Set([
    'viewport',
    'locale',
    'timezone',
    'consentStrategy',
    'geolocation',
]);

/**
 * Exact own keys accepted on a model-selected geolocation object.
 */
const AGENT_BROWSER_GEOLOCATION_KEYS = new Set(['latitude', 'longitude']);

/**
 * Determine whether a parsed JSON value is an ordinary key-value object.
 *
 * @param value - Candidate value parsed from a tool argument.
 * @returns Whether the value is a non-array object with a safe standard or null prototype.
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Check an object's own enumerable keys against one explicit allowlist.
 *
 * This closes a Valibot strict-object edge case for names inherited from `Object.prototype`, such
 * as `constructor`, `toString`, and `__proto__`.
 *
 * @param value - Plain object whose keys must be checked.
 * @param allowedKeys - Complete accepted own-key set.
 * @returns Whether every own enumerable key is explicitly allowed.
 */
function hasOnlyAllowedOwnKeys(
    value: Record<string, unknown>,
    allowedKeys: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

/**
 * Normalize the one known nested JSON-string artifact emitted by compatible model providers.
 *
 * Only `profile` is parsed, at most once. The returned object uses the existing strict Valibot
 * schema output and never merges unvalidated parsed data into browser configuration.
 *
 * @param args - Raw `launch_browser` arguments supplied by the model.
 * @returns Arguments containing a validated object profile, or a stable invalid sentinel that the
 *   existing launch schema rejects.
 */
export function normalizeLaunchBrowserArguments(
    args: Record<string, unknown>,
): Record<string, unknown> {
    const rawProfile = args.profile;
    let candidateProfile: unknown = rawProfile;
    if (typeof rawProfile === 'string') {
        if (rawProfile.length === 0 || rawProfile.length > MAX_ENCODED_BROWSER_PROFILE_LENGTH) {
            return { ...args, profile: null };
        }
        try {
            candidateProfile = JSON.parse(rawProfile) as unknown;
        } catch {
            return { ...args, profile: null };
        }
    }
    if (!isPlainJsonObject(candidateProfile)) {
        return { ...args, profile: null };
    }
    if (!hasOnlyAllowedOwnKeys(candidateProfile, AGENT_BROWSER_PROFILE_KEYS)) {
        return { ...args, profile: null };
    }
    if (
        candidateProfile.geolocation !== undefined &&
        (!isPlainJsonObject(candidateProfile.geolocation) ||
            !hasOnlyAllowedOwnKeys(candidateProfile.geolocation, AGENT_BROWSER_GEOLOCATION_KEYS))
    ) {
        return { ...args, profile: null };
    }
    const parsedProfile = v.safeParse(AgentBrowserProfileSchema, candidateProfile);
    if (!parsedProfile.success) {
        return { ...args, profile: candidateProfile };
    }
    return { ...args, profile: parsedProfile.output };
}

/**
 * Detect an unsupported geographic proxy request before strict launch validation.
 *
 * The compatibility branch recognizes both the object form and the one bounded JSON-encoded profile
 * form accepted from model providers. It never treats the field as applied: the runtime has no
 * proxy backend and must tell the model that network egress stayed unchanged.
 *
 * @param args - Raw `launch_browser` arguments supplied by the model.
 * @returns Whether the model explicitly requested the unsupported `proxyRegion` field.
 */
export function requestsUnsupportedProxyRegion(args: Record<string, unknown>): boolean {
    let candidateProfile: unknown = args.profile;
    if (typeof candidateProfile === 'string') {
        if (
            candidateProfile.length === 0 ||
            candidateProfile.length > MAX_ENCODED_BROWSER_PROFILE_LENGTH
        ) {
            return false;
        }
        try {
            candidateProfile = JSON.parse(candidateProfile) as unknown;
        } catch {
            return false;
        }
    }
    return (
        isPlainJsonObject(candidateProfile) &&
        Object.prototype.hasOwnProperty.call(candidateProfile, 'proxyRegion')
    );
}

import { createHash, X509Certificate } from 'node:crypto';
import * as v from 'valibot';

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));

export const StrictBrowserNavigationProofSchema = v.strictObject({
    routeId: v.pipe(v.string(), v.uuid()),
    requestedUrl: v.pipe(v.string(), v.url()),
    finalUrl: v.pipe(v.string(), v.url()),
    cacheDisposition: v.literal('network'),
    certificateChainSha256: v.pipe(v.array(Sha256Schema), v.minLength(1), v.maxLength(16)),
    trustAnchorSha256: Sha256Schema,
    verifiedAt: v.pipe(v.string(), v.isoTimestamp()),
});

/**
 * Public path-free proof that one strict route carried a non-cached HTTPS navigation.
 */
export type StrictBrowserNavigationProof = v.InferOutput<typeof StrictBrowserNavigationProofSchema>;

/**
 * Private state retained for one isolated browser route.
 */
export interface StrictBrowserRouteState {
    /**
     * Route identity.
     */
    routeId: string;
    /**
     * Owning cycle identity.
     */
    cycleId: string;
    /**
     * Exact canonical target URL.
     */
    targetUrl: string;
    /**
     * Loopback HTTP proxy URL.
     */
    proxyUrl: string;
    /**
     * Canonical Chromium SPKI SHA-256 pin.
     */
    spkiSha256Base64: string;
    /**
     * Generated CA certificate encoded as base64 DER.
     */
    certificateDerBase64: string;
    /**
     * SHA-256 of generated CA DER.
     */
    certificateSha256: string;
    /**
     * Canonical agent-owned browser root.
     */
    browserRoot: string;
    /**
     * Expiration timestamp for this one-use route.
     */
    expiresAt: string;
}

declare const preparedStrictBrowserRouteBrand: unique symbol;

/**
 * Opaque one-use browser route issued by trusted Host code.
 */
export interface PreparedStrictBrowserRoute {
    /**
     * Prevent structural construction.
     */
    readonly [preparedStrictBrowserRouteBrand]: true;
}

interface StoredStrictRoute {
    /**
     * Immutable private route state.
     */
    state: Readonly<StrictBrowserRouteState>;
    /**
     * Whether the route was consumed by a browser.
     */
    consumed: boolean;
}

/**
 * Cache and service-worker facts for one final main-document response.
 */
export interface StrictBrowserNetworkDisposition {
    /**
     * Whether Chromium served the response from cache.
     */
    fromCache: boolean;
    /**
     * Whether a service worker served the response.
     */
    fromServiceWorker: boolean;
}

const strictRouteStates = new WeakMap<PreparedStrictBrowserRoute, StoredStrictRoute>();

/**
 * Validate a canonical credential-free HTTP or HTTPS route target.
 *
 * Plain `http:` targets are accepted deliberately: reporters paste them (live run 32706975563
 * failed task #239090 over `http://www.emaillink.adtidy.org/`), the CLI proxy filters plaintext
 * traffic exactly as it filters TLS, and the route's TLS machinery — the SPKI launch pin and
 * {@link verifyStrictBrowserNavigation} — simply never engages for a connection that carries no
 * certificate. Fragments are accepted because the reporter's URL may carry one and `page.url()`
 * echoes it back; they never reach the network.
 *
 * @param value - Candidate URL.
 * @returns Parsed canonical URL.
 */
function parseStrictTargetUrl(value: string): URL {
    const url = new URL(value);
    if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username !== '' ||
        url.password !== '' ||
        url.href !== value
    ) {
        throw new Error('strict_route_target_invalid');
    }
    return url;
}

/**
 * Validate a canonical credential-free HTTPS URL.
 *
 * The navigation proof verifies a certificate chain, which only exists for TLS, so this stricter
 * parse guards {@link verifyStrictBrowserNavigation} alone; route creation accepts plain HTTP via
 * {@link parseStrictTargetUrl}.
 *
 * @param value - Candidate URL.
 * @returns Parsed canonical URL.
 */
function parseHttpsUrl(value: string): URL {
    const url = parseStrictTargetUrl(value);
    if (url.protocol !== 'https:') {
        throw new Error('strict_route_target_invalid');
    }
    return url;
}

/**
 * Issue one opaque strict browser route after validating all public bindings.
 *
 * @param state - Private route state.
 * @returns One-use route capability.
 */
export function createPreparedStrictBrowserRoute(
    state: StrictBrowserRouteState,
): PreparedStrictBrowserRoute {
    parseStrictTargetUrl(state.targetUrl);
    const proxy = new URL(state.proxyUrl);
    if (
        proxy.protocol !== 'http:' ||
        proxy.hostname !== '127.0.0.1' ||
        proxy.username !== '' ||
        proxy.password !== '' ||
        proxy.pathname !== '/' ||
        proxy.search !== '' ||
        proxy.hash !== '' ||
        proxy.port === ''
    ) {
        throw new Error('strict_route_proxy_invalid');
    }
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(state.spkiSha256Base64)) {
        throw new Error('strict_route_spki_invalid');
    }
    const certificate = Buffer.from(state.certificateDerBase64, 'base64');
    const certificateSha256 = createHash('sha256').update(certificate).digest('hex');
    if (certificateSha256 !== state.certificateSha256) {
        throw new Error('strict_route_certificate_mismatch');
    }
    if (Date.parse(state.expiresAt) <= Date.now()) {
        throw new Error('strict_route_expired');
    }
    const route = Object.freeze(Object.create(null)) as PreparedStrictBrowserRoute;
    strictRouteStates.set(route, {
        state: Object.freeze(structuredClone(state)),
        consumed: false,
    });
    return route;
}

/**
 * Inspect an issued route without consuming it.
 *
 * @param route - Opaque route capability.
 * @returns Defensive private state copy, or null for a forged capability.
 */
export function inspectPreparedStrictBrowserRoute(
    route: PreparedStrictBrowserRoute,
): StrictBrowserRouteState | null {
    const stored = strictRouteStates.get(route);
    return stored ? structuredClone(stored.state) : null;
}

/**
 * Atomically consume one route for its exact target.
 *
 * @param route - Opaque route capability.
 * @param targetUrl - Exact target the browser will navigate.
 * @param now - Current time used for expiry checks.
 * @returns Private state for trusted browser code.
 */
export function consumePreparedStrictBrowserRoute(
    route: PreparedStrictBrowserRoute,
    targetUrl: string,
    now: Date = new Date(),
): StrictBrowserRouteState {
    const stored = strictRouteStates.get(route);
    if (!stored) {
        throw new Error('strict_route_forged');
    }
    if (stored.consumed) {
        throw new Error('strict_route_replayed');
    }
    if (stored.state.targetUrl !== targetUrl) {
        throw new Error('strict_route_target_mismatch');
    }
    if (Date.parse(stored.state.expiresAt) <= now.getTime()) {
        throw new Error('strict_route_expired');
    }
    stored.consumed = true;
    return structuredClone(stored.state);
}

/**
 * Verify a DER certificate chain against the generated route CA.
 *
 * @param state - Consumed strict route state.
 * @param requestedUrl - Original exact request URL.
 * @param finalUrl - Final main-document URL after redirects.
 * @param chainDerBase64 - Leaf-first CDP certificate chain.
 * @param observed - Cache and service-worker facts.
 * @param observed.fromCache - Whether Chromium served the response from cache.
 * @param observed.fromServiceWorker - Whether a service worker served the response.
 * @param now - Verification clock.
 * @returns Path-free cryptographic navigation proof.
 */
export function verifyStrictBrowserNavigation(
    state: StrictBrowserRouteState,
    requestedUrl: string,
    finalUrl: string,
    chainDerBase64: readonly string[],
    observed: StrictBrowserNetworkDisposition,
    now: Date = new Date(),
): StrictBrowserNavigationProof {
    if (requestedUrl !== state.targetUrl) {
        throw new Error('strict_route_target_mismatch');
    }
    const final = parseHttpsUrl(finalUrl);
    const requested = parseHttpsUrl(requestedUrl);
    if (final.origin !== requested.origin) {
        throw new Error('strict_route_origin_bypass');
    }
    if (observed.fromCache || observed.fromServiceWorker) {
        throw new Error('strict_route_not_network');
    }
    if (chainDerBase64.length === 0 || chainDerBase64.length > 16) {
        throw new Error('strict_route_certificate_chain_invalid');
    }
    const routeCaDer = Buffer.from(state.certificateDerBase64, 'base64');
    const routeCa = new X509Certificate(routeCaDer);
    const chain = chainDerBase64.map(
        (encoded) => new X509Certificate(Buffer.from(encoded, 'base64')),
    );
    if (chain[0].checkHost(final.hostname) === undefined) {
        throw new Error('strict_route_certificate_hostname_mismatch');
    }
    for (let index = 0; index < chain.length - 1; index += 1) {
        if (!chain[index].verify(chain[index + 1].publicKey)) {
            throw new Error('strict_route_certificate_chain_invalid');
        }
    }
    const terminal = chain[chain.length - 1];
    const terminalDigest = createHash('sha256').update(terminal.raw).digest('hex');
    if (terminalDigest !== state.certificateSha256 && !terminal.verify(routeCa.publicKey)) {
        throw new Error('strict_route_trust_anchor_mismatch');
    }
    return v.parse(StrictBrowserNavigationProofSchema, {
        routeId: state.routeId,
        requestedUrl,
        finalUrl,
        cacheDisposition: 'network',
        certificateChainSha256: chain.map((certificate) =>
            createHash('sha256').update(certificate.raw).digest('hex'),
        ),
        trustAnchorSha256: state.certificateSha256,
        verifiedAt: now.toISOString(),
    });
}

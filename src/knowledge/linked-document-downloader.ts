import { createHash } from 'node:crypto';

/**
 * Hard deadline for one linked-document download.
 *
 * One-shot run-start fetch: the loader downloads each linked instruction document once at the start
 * of a run, with no cache and no retry convention anywhere upstream. A machine that has not
 * answered in 30s forfeits the run as a typed unreachable-link failure instead of stretching the
 * startup phase.
 */
export const LINKED_DOCUMENT_TIMEOUT_MS = 30_000;

/**
 * Largest accepted linked document.
 *
 * Far above any syntax, policy or contributing wiki page, so the cap rejects binary floods and
 * scraped archives — never truncating a real document: over the cap is a typed failure, not a
 * shorter document.
 */
export const MAX_LINKED_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * Stable failure classes of the linked-document downloader.
 */
export const LinkedDocumentDownloadFailureCode = {
    /**
     * The URL could not be fetched: rejected, timed out, answered non-2xx, or does not parse.
     */
    DocumentUnavailable: 'document_unavailable',

    /**
     * The body exceeds {@link MAX_LINKED_DOCUMENT_BYTES}.
     */
    DocumentTooLarge: 'document_too_large',

    /**
     * The body carries no usable text.
     */
    DocumentEmpty: 'document_empty',

    /**
     * The URL is not an http(s) resource (or does not parse at all).
     */
    DocumentSchemeUnsupported: 'document_scheme_unsupported',

    /**
     * The URL embeds credentials; they must never reach a fetch or a log line.
     */
    DocumentCredential: 'document_credential',
} as const;

/**
 * Every LinkedDocumentDownloadFailureCode value, for schemas and exhaustive listings.
 */
export const LINKED_DOCUMENT_DOWNLOAD_FAILURE_CODES = Object.values(
    LinkedDocumentDownloadFailureCode,
);

/**
 * LinkedDocumentDownloadFailureCode value.
 */
export type LinkedDocumentDownloadFailureCode =
    (typeof LinkedDocumentDownloadFailureCode)[keyof typeof LinkedDocumentDownloadFailureCode];

/**
 * Replace any userinfo section of a URL string with a marker so the failure text identifies the
 * resource without echoing its embedded credentials.
 *
 * @param url - Raw URL string as supplied by the caller.
 * @returns The same URL with `user:password` collapsed into a redaction marker.
 */
function redactUrlCredentials(url: string): string {
    return url.replace(/\/\/[^/@\s]+@/u, '//[redacted]@');
}

/**
 * Stable, URL-naming downloader failure.
 *
 * The message always names the requested URL — with any userinfo redacted — so a failed run start
 * is diagnosable from the error alone while embedded secrets stay out of logs and artifacts.
 */
export class LinkedDocumentDownloadError extends Error {
    /**
     * Stable public failure classification.
     */
    readonly code: LinkedDocumentDownloadFailureCode;

    /**
     * Requested URL, redacted of any embedded userinfo.
     */
    readonly url: string;

    /**
     * Concrete cause observed (status, timeout, scheme, byte cap).
     */
    readonly detail: string;

    /**
     * Underlying error observed at fetch time, when one exists.
     */
    override readonly cause?: unknown;

    /**
     * Create one URL-naming download failure.
     *
     * @param code - Stable public failure classification.
     * @param url - Requested URL; redacted before it reaches the message.
     * @param detail - Concrete cause observed (status, timeout, scheme, byte cap).
     * @param cause - Underlying error, when one exists.
     */
    constructor(
        code: LinkedDocumentDownloadFailureCode,
        url: string,
        detail: string,
        cause?: unknown,
    ) {
        super(
            `Linked document download failed (${code}) for ` +
                `${redactUrlCredentials(url)}: ${detail}.`,
        );
        this.name = 'LinkedDocumentDownloadError';
        this.code = code;
        this.url = url;
        this.detail = detail;
        this.cause = cause;
    }
}

/**
 * One downloaded remote document offered as this run's rule-guidance text.
 */
export interface DownloadedLinkedDocument {
    /**
     * Exact requested URL, unmodified.
     */
    url: string;

    /**
     * Complete UTF-8 text of the body.
     */
    content: string;

    /**
     * SHA-256 over the exact response bytes, so a run can state what it served.
     */
    sha256: string;
}

/**
 * Fetch one linked document within the declared size and time bounds.
 *
 * The whole body must arrive as usable text inside one request: over the byte cap or empty is a
 * typed failure, never a truncated or padded document — the instruction documents are read "as they
 * are", so any silent rewrite would corrupt the exact text the run cites.
 *
 * @param url - Http(s) URL of the document to fetch.
 * @param fetchImpl - Injectable fetch for deterministic tests; production uses global fetch.
 * @returns The body text and its SHA-256 digest over the exact bytes.
 * @throws {LinkedDocumentDownloadError} With a stable code naming the URL for every failure class.
 */
export async function downloadLinkedDocument(
    url: string,
    fetchImpl: typeof fetch = fetch,
): Promise<DownloadedLinkedDocument> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
            url,
            'URL cannot be parsed',
        );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentSchemeUnsupported,
            url,
            `unsupported protocol ${parsed.protocol}; only http(s) documents are fetched`,
        );
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentCredential,
            url,
            'URL embeds credentials; they are never fetched or stored',
        );
    }

    let response: Response;
    try {
        response = await fetchImpl(url, {
            signal: AbortSignal.timeout(LINKED_DOCUMENT_TIMEOUT_MS),
            redirect: 'follow',
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `fetch failed: ${detail}`,
            error,
        );
    }
    if (!response.ok) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `unexpected HTTP status ${response.status}`,
        );
    }

    const declaredLength = response.headers.get('content-length');
    const declaredBytes = declaredLength === null ? 0 : Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_LINKED_DOCUMENT_BYTES) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
            url,
            `declared content-length ${declaredLength} exceeds the ` +
                `${MAX_LINKED_DOCUMENT_BYTES}-byte cap`,
        );
    }

    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentUnavailable,
            url,
            `body could not be read: ${detail}`,
            error,
        );
    }
    if (bytes.byteLength > MAX_LINKED_DOCUMENT_BYTES) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentTooLarge,
            url,
            `body is ${bytes.byteLength} bytes, above the ${MAX_LINKED_DOCUMENT_BYTES}-byte cap`,
        );
    }
    const content = new TextDecoder('utf-8').decode(bytes);
    if (content.trim().length === 0) {
        throw new LinkedDocumentDownloadError(
            LinkedDocumentDownloadFailureCode.DocumentEmpty,
            url,
            'body carries no usable text',
        );
    }

    return {
        url,
        content,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

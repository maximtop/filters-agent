import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserToolHandlers } from '../browser/browser-tools';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { IssueFacts, IssueScreenshot } from '../types/issue-facts';
import type { ReproProfile } from '../types/repro-profile';
import type { Finding, MatchedIssueScreenshot, SiteAnalysisReport } from '../types/site-analysis';
import { classifyBrowserPreflight, type BrowserPreflightClassification } from './browser-first-run';
import {
    defaultHostnameResolver,
    validatePublicHttpUrl,
    type HostnameResolver,
} from '../browser/network-safety';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * Trusted hostnames from which pilot issue screenshots may be downloaded.
 */
const TRUSTED_SCREENSHOT_HOSTNAMES = ['cdn.adguardcdn.com'] as const;

/**
 * Maximum accepted issue screenshot size in bytes.
 */
const DEFAULT_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Maximum number of explicitly validated screenshot redirects.
 */
const MAX_SCREENSHOT_REDIRECTS = 3;

/**
 * Raster image content types safe to persist as screenshot artifacts.
 */
const SUPPORTED_SCREENSHOT_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

/**
 * Downloaded and validated screenshot payload.
 */
interface TrustedScreenshotDownload {
    /**
     * Bounded image bytes.
     */
    buffer: Buffer;

    /**
     * Safe filename extension derived from the response content type.
     */
    extension: string;
}

/**
 * Whether an HTTP status represents a redirect that carries a Location header.
 *
 * @param status - HTTP response status.
 * @returns True for 301, 302, 303, 307, and 308.
 */
function isRedirectStatus(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
}

/**
 * Choose a non-executable image extension from a validated image content type.
 *
 * @param contentType - Lowercase MIME type without parameters.
 * @returns Safe image filename extension.
 */
function imageExtension(contentType: string): string {
    if (contentType === 'image/jpeg') {
        return 'jpg';
    }
    if (contentType === 'image/webp') {
        return 'webp';
    }
    if (contentType === 'image/gif') {
        return 'gif';
    }
    return 'png';
}

/**
 * Read a fetch response incrementally while enforcing a hard byte limit.
 *
 * @param response - Successful image response.
 * @param maxBytes - Maximum number of bytes to buffer.
 * @returns Bounded response bytes.
 */
async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(`Screenshot exceeds the ${maxBytes}-byte limit.`);
    }
    if (!response.body) {
        throw new Error('Screenshot response has no body.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Screenshot exceeds the ${maxBytes}-byte limit.`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, total);
}

/**
 * Download one issue screenshot through an HTTPS-only, allowlisted, redirect-checked path.
 *
 * @param rawUrl - Untrusted screenshot URL from the issue body.
 * @param fetcher - Fetch implementation used for each manually followed hop.
 * @param resolveHostname - Resolver used to reject private DNS answers.
 * @param maxBytes - Hard response byte limit.
 * @returns Validated screenshot bytes and safe extension.
 */
async function downloadTrustedScreenshot(
    rawUrl: string,
    fetcher: typeof fetch,
    resolveHostname: HostnameResolver,
    maxBytes: number,
): Promise<TrustedScreenshotDownload> {
    let currentUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_SCREENSHOT_REDIRECTS; redirects += 1) {
        const safeUrl = await validatePublicHttpUrl(currentUrl, {
            allowedHostnames: TRUSTED_SCREENSHOT_HOSTNAMES,
            httpsOnly: true,
            resolveHostname,
        });
        if (safeUrl.port && safeUrl.port !== '443') {
            throw new Error('Screenshot URL must use the default HTTPS port.');
        }

        const response = await fetcher(safeUrl.href, { redirect: 'manual' });
        if (isRedirectStatus(response.status)) {
            if (redirects === MAX_SCREENSHOT_REDIRECTS) {
                throw new Error('Screenshot redirect limit exceeded.');
            }
            const location = response.headers.get('location');
            if (!location) {
                throw new Error('Screenshot redirect is missing a Location header.');
            }
            currentUrl = new URL(location, safeUrl).href;
            continue;
        }
        if (!response.ok) {
            throw new Error(`Screenshot download returned HTTP ${response.status}.`);
        }
        const contentType = response.headers
            .get('content-type')
            ?.split(';', 1)[0]
            .trim()
            .toLowerCase();
        if (!contentType || !SUPPORTED_SCREENSHOT_CONTENT_TYPES.has(contentType)) {
            throw new Error(
                'Screenshot response does not have a supported raster image content type.',
            );
        }
        return {
            buffer: await readBoundedResponse(response, maxBytes),
            extension: imageExtension(contentType),
        };
    }
    throw new Error('Screenshot redirect limit exceeded.');
}

/**
 * Configuration for creating a SiteAnalyzer instance.
 */
export interface SiteAnalyzerConfig {
    /**
     * The browser tool handlers for interacting with the live page.
     */
    handlers: BrowserToolHandlers;

    /**
     * Directory where artifacts are written.
     */
    artifactsDir: string;

    /**
     * Trace recorder for registering artifact references.
     */
    recorder: TraceRecorder;

    /**
     * Injectable fetch implementation for issue screenshot downloads.
     */
    screenshotFetcher?: typeof fetch;

    /**
     * Injectable DNS resolver for screenshot host validation.
     */
    screenshotResolveHostname?: HostnameResolver;

    /**
     * Maximum accepted screenshot response size in bytes.
     */
    screenshotMaxBytes?: number;

    /**
     * Issue screenshot records captured before the browser session was launched.
     */
    preloadedIssueScreenshots?: MatchedIssueScreenshot[];
}

/**
 * Dependencies for capturing trusted screenshots without a browser session.
 */
export interface IssueScreenshotCaptureOptions {
    /**
     * Directory where downloaded screenshot artifacts are written.
     */
    artifactsDir: string;

    /**
     * Trace recorder that owns the screenshot artifact references.
     */
    recorder: TraceRecorder;

    /**
     * Injectable fetch implementation for issue screenshot downloads.
     */
    fetcher?: typeof fetch;

    /**
     * Injectable DNS resolver for screenshot host validation.
     */
    resolveHostname?: HostnameResolver;

    /**
     * Maximum accepted screenshot response size in bytes.
     */
    maxBytes?: number;
}

/**
 * Download and register issue screenshots through the trusted evidence path.
 *
 * This helper deliberately has no browser dependency, so callers can preserve the reporter's visual
 * evidence before attempting a browser launch or when the live browser is unavailable. Individual
 * download failures are returned as descriptions instead of aborting the run.
 *
 * @param screenshots - Untrusted screenshot references parsed from the issue body.
 * @param options - Artifact storage, trace recorder, and injectable network dependencies.
 * @returns Screenshot records containing registered artifact IDs or bounded failure descriptions.
 */
export async function captureIssueScreenshots(
    screenshots: IssueScreenshot[],
    options: IssueScreenshotCaptureOptions,
): Promise<MatchedIssueScreenshot[]> {
    mkdirSync(options.artifactsDir, { recursive: true });
    const fetcher = options.fetcher ?? fetch;
    const resolveHostname = options.resolveHostname ?? defaultHostnameResolver;
    const maxBytes = options.maxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;
    const results: MatchedIssueScreenshot[] = [];

    for (const screenshot of screenshots) {
        try {
            const download = await downloadTrustedScreenshot(
                screenshot.url,
                fetcher,
                resolveHostname,
                maxBytes,
            );
            const id = randomUUID();
            const filename = `${id}.${download.extension}`;
            const fullPath = join(options.artifactsDir, filename);
            writeFileSync(fullPath, download.buffer);
            options.recorder.addArtifact({
                id,
                path: fullPath,
                type: 'issue-screenshot',
                bytes: download.buffer.length,
            });
            results.push({
                issueScreenshotUrl: screenshot.url,
                liveArtifactId: id,
                description: screenshot.description ?? 'Issue screenshot downloaded',
            });
        } catch (err) {
            results.push({
                issueScreenshotUrl: screenshot.url,
                description: `Download error: ${(err as Error).message}`,
            });
        }
    }

    return results;
}

/**
 * Result of the deterministic browser preflight performed before the LLM tool loop.
 */
export interface SitePreflightResult {
    /**
     * Browser report assembled from the attempted navigation and captures.
     */
    report: SiteAnalysisReport;

    /**
     * Deterministic decision about whether the browser evidence is usable.
     */
    classification: BrowserPreflightClassification;
}

/**
 * Orchestrates a live browser session for site analysis.
 *
 * Holds a mutable findings accumulator populated by the `report_finding` tool (called by the LLM
 * during the agent loop). After the loop finishes, {@link analyze} assembles the
 * `SiteAnalysisReport` from the session's collected artifacts and the accumulated findings.
 */
export class SiteAnalyzer {
    private readonly handlers: BrowserToolHandlers;
    private readonly artifactsDir: string;
    private readonly recorder: TraceRecorder;
    private readonly findings: Finding[] = [];
    private readonly screenshotFetcher: typeof fetch;
    private readonly screenshotResolveHostname: HostnameResolver;
    private readonly screenshotMaxBytes: number;
    private readonly preloadedIssueScreenshots: MatchedIssueScreenshot[];

    /**
     * @param config - Tool handlers, output directory, and trace recorder.
     */
    constructor(config: SiteAnalyzerConfig) {
        this.handlers = config.handlers;
        this.artifactsDir = config.artifactsDir;
        this.recorder = config.recorder;
        this.screenshotFetcher = config.screenshotFetcher ?? fetch;
        this.screenshotResolveHostname =
            config.screenshotResolveHostname ?? defaultHostnameResolver;
        this.screenshotMaxBytes = config.screenshotMaxBytes ?? DEFAULT_SCREENSHOT_MAX_BYTES;
        this.preloadedIssueScreenshots = [...(config.preloadedIssueScreenshots ?? [])];
    }

    /**
     * Return a snapshot of the current findings accumulator.
     *
     * @returns The collected findings so far.
     */
    getFindings(): Finding[] {
        return this.findings;
    }

    /**
     * Append a finding to the accumulator (called by the `report_finding` tool handler).
     *
     * @param finding - The finding reported by the LLM.
     */
    addFinding(finding: Finding): void {
        this.findings.push(finding);
    }

    /**
     * Clear all accumulated findings (used when the site is unreachable and findings are moot).
     */
    clearFindings(): void {
        this.findings.length = 0;
    }

    /**
     * Run the analysis workflow: open the page, capture screenshots/DOM/network log, download issue
     * screenshots for comparison, and assemble the final report.
     *
     * If the site is unreachable, findings are cleared and an unreachable report is returned.
     *
     * @param facts - The parsed issue facts.
     * @param profile - The reproduction profile used for the session.
     * @returns The assembled site analysis report.
     */
    async analyze(facts: IssueFacts, profile: ReproProfile): Promise<SiteAnalysisReport> {
        const result = await this.preflight(facts, profile);
        return result.report;
    }

    /**
     * Navigate and capture the target before the LLM receives browser tools.
     *
     * This method owns technical usability classification. It never treats a successfully usable
     * page with zero findings as a browser failure; findings are populated later by the LLM tool
     * loop and interpreted by the run orchestrator.
     *
     * @param facts - Parsed issue facts containing the reported URL and screenshots.
     * @param profile - Reproduction profile used by the active browser session.
     * @returns The captured report and deterministic usability classification.
     */
    async preflight(facts: IssueFacts, profile: ReproProfile): Promise<SitePreflightResult> {
        const url = facts.reportedSiteUrls[0] ?? '';
        const matchedIssueScreenshots = await this.matchIssueScreenshots(facts.screenshots);

        const openResult = await this.handlers.open_page({ url });
        if (openResult.error) {
            this.clearFindings();
            const fallbackReason = openResult.fallbackReason as BrowserFallbackReason | undefined;
            const classification = classifyBrowserPreflight({
                statusCode: typeof openResult.statusCode === 'number' ? openResult.statusCode : 0,
                title: typeof openResult.title === 'string' ? openResult.title : '',
                htmlLength: 0,
                visibleTextPreview: '',
                navigationFailureReason: fallbackReason ?? BrowserFallbackReason.NavigationTimeout,
                navigationFailureDetail: String(openResult.error),
            });
            return {
                classification,
                report: {
                    url,
                    reproProfile: profile,
                    screenshots: [],
                    findings: [],
                    matchedIssueScreenshots,
                    unreachable: true,
                    unreachableError: String(openResult.error),
                },
            };
        }

        let ssResult: Record<string, unknown>;
        let domResult: Record<string, unknown>;
        let netResult: Record<string, unknown>;
        try {
            ssResult = await this.handlers.screenshot({});
            domResult = await this.handlers.get_dom({});
            netResult = await this.handlers.get_network_log({});
        } catch (err) {
            this.clearFindings();
            const detail = `Browser artifact capture failed: ${(err as Error).message}`;
            return {
                classification: {
                    usable: false,
                    fallbackReason: BrowserFallbackReason.ArtifactCaptureFailed,
                    fallbackDetail: detail,
                },
                report: {
                    url: typeof openResult.url === 'string' ? openResult.url : url,
                    reproProfile: profile,
                    screenshots: [],
                    findings: [],
                    matchedIssueScreenshots,
                    unreachable: true,
                    unreachableError: detail,
                },
            };
        }

        const screenshotArtifactId =
            typeof ssResult.artifactId === 'string' ? ssResult.artifactId : undefined;
        const domArtifactId =
            typeof domResult.artifactId === 'string' ? domResult.artifactId : undefined;
        const harArtifactId =
            typeof netResult.artifactId === 'string' ? netResult.artifactId : undefined;
        const classification = classifyBrowserPreflight({
            statusCode: typeof openResult.statusCode === 'number' ? openResult.statusCode : 200,
            title: typeof openResult.title === 'string' ? openResult.title : '',
            htmlLength: typeof domResult.htmlLength === 'number' ? domResult.htmlLength : 0,
            visibleTextPreview:
                typeof domResult.visibleTextPreview === 'string'
                    ? domResult.visibleTextPreview
                    : '',
            screenshotArtifactId,
            domArtifactId,
            harArtifactId,
        });
        if (!classification.usable) {
            this.clearFindings();
        }

        return {
            classification,
            report: {
                url: typeof openResult.url === 'string' ? openResult.url : url,
                reproProfile: profile,
                screenshots: screenshotArtifactId ? [screenshotArtifactId] : [],
                domSnapshotArtifactId: domArtifactId,
                harArtifactId,
                findings: [...this.findings],
                matchedIssueScreenshots,
                unreachable: !classification.usable,
                unreachableError: classification.fallbackDetail ?? undefined,
            },
        };
    }

    /**
     * Download issue screenshots for side-by-side comparison with live captures.
     *
     * @param screenshots - The issue screenshots to download.
     * @returns Matched screenshot records with artifact IDs or error descriptions.
     */
    private async matchIssueScreenshots(
        screenshots: IssueScreenshot[],
    ): Promise<MatchedIssueScreenshot[]> {
        const preloadedUrls = new Set(
            this.preloadedIssueScreenshots.map((screenshot) => screenshot.issueScreenshotUrl),
        );
        const screenshotsToCapture = screenshots.filter(
            (screenshot) => !preloadedUrls.has(screenshot.url),
        );
        const captured = await captureIssueScreenshots(screenshotsToCapture, {
            artifactsDir: this.artifactsDir,
            recorder: this.recorder,
            fetcher: this.screenshotFetcher,
            resolveHostname: this.screenshotResolveHostname,
            maxBytes: this.screenshotMaxBytes,
        });
        return [...this.preloadedIssueScreenshots, ...captured];
    }
}

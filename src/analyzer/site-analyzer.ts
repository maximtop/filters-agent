import type { BrowserToolHandlers } from '../browser/browser-tools';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { IssueFacts, IssueScreenshot } from '../types/issue-facts';
import type { ReproProfile } from '../types/repro-profile';
import type { Finding, MatchedIssueScreenshot, SiteAnalysisReport } from '../types/site-analysis';
import { classifyBrowserPreflight, type BrowserPreflightClassification } from './browser-first-run';
import { defaultHostnameResolver, type HostnameResolver } from '../browser/network-safety';
import { captureIssueScreenshots, DEFAULT_SCREENSHOT_MAX_BYTES } from './issue-screenshot-capture';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';

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

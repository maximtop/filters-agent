import { EffectiveMode } from '../types/fix-run-result';
import { BrowserMode } from '../types/browser-mode';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * Browser evidence collected by the deterministic preflight.
 */
export interface BrowserPreflightEvidence {
    /**
     * Main-document HTTP response status.
     */
    statusCode: number;

    /**
     * Page title after navigation.
     */
    title: string;

    /**
     * Number of characters in the captured HTML document.
     */
    htmlLength: number;

    /**
     * Visible page text sampled from the DOM capture.
     */
    visibleTextPreview: string;

    /**
     * Screenshot artifact identifier, when capture succeeded.
     */
    screenshotArtifactId?: string;

    /**
     * DOM artifact identifier, when capture succeeded.
     */
    domArtifactId?: string;

    /**
     * HAR artifact identifier, when capture succeeded.
     */
    harArtifactId?: string;

    /**
     * Structured failure produced by navigation, when navigation failed.
     */
    navigationFailureReason?: BrowserFallbackReason;

    /**
     * Diagnostic detail for a navigation failure.
     */
    navigationFailureDetail?: string;
}

/**
 * Deterministic usability decision for one browser preflight attempt.
 */
export interface BrowserPreflightClassification {
    /**
     * Whether browser evidence is usable for the agent run.
     */
    usable: boolean;

    /**
     * Technical fallback category, or null for a usable page.
     */
    fallbackReason: BrowserFallbackReason | null;

    /**
     * Human-readable diagnostic detail, or null for a usable page.
     */
    fallbackDetail: string | null;
}

/**
 * Resolution of requested browser behavior after preflight.
 */
export interface BrowserModeResolution {
    /**
     * Mode that the rest of the run must use.
     */
    effectiveMode: EffectiveMode;

    /**
     * Whether a reasoning-only continuation is permitted.
     */
    mayUseReasoningFallback: boolean;
}

/**
 * Text commonly shown by bot challenges rather than the requested page.
 */
const BOT_CHALLENGE_RE =
    /just a moment|verify (?:you are|that you are) human|captcha|checking your browser|cloudflare/i;

/**
 * Text commonly shown when content is unavailable in the current region.
 *
 * The Russian alternative is not decoration: a live run judged a Rutube pre-roll report
 * `not_reproduced` while the player showed "Видео недоступно из-за ограничений в вашей стране" in
 * the very text this pattern reads (#238615, 2026-08-22). A player that never starts cannot show a
 * pre-roll, so the missing advertisement proved nothing.
 */
const GEO_BLOCK_RE =
    /not available in (?:your|this) (?:country|region)|unavailable in your location|geo(?:graphically)? blocked|недоступн[а-яё]* (?:[^\n]{0,40})?в вашей стране|ограничени[а-яё]+ в вашей стране/i;

/**
 * Decide whether page text says the requested content was withheld rather than shown.
 *
 * Exported so a caller holding only navigation and text facts — one browser session inside a run,
 * rather than a full preflight capture — reaches exactly the same judgement.
 *
 * @param evidence - Title and visible text observed after navigation.
 * @returns The withholding category, or null when the text reads as ordinary page content.
 */
export function classifyWithheldPageText(
    evidence: Pick<BrowserPreflightEvidence, 'title' | 'visibleTextPreview'>,
): typeof BrowserFallbackReason.GeoBlocked | typeof BrowserFallbackReason.BotChallenge | null {
    const pageText = `${evidence.title}\n${evidence.visibleTextPreview}`;
    if (GEO_BLOCK_RE.test(pageText)) {
        return BrowserFallbackReason.GeoBlocked;
    }
    if (BOT_CHALLENGE_RE.test(pageText)) {
        return BrowserFallbackReason.BotChallenge;
    }
    return null;
}

/**
 * Classify one preflight without delegating technical fallback decisions to the LLM.
 *
 * @param evidence - Navigation and capture evidence from the browser tools.
 * @returns A deterministic usability decision and fallback taxonomy.
 */
export function classifyBrowserPreflight(
    evidence: BrowserPreflightEvidence,
): BrowserPreflightClassification {
    if (evidence.navigationFailureReason) {
        return {
            usable: false,
            fallbackReason: evidence.navigationFailureReason,
            fallbackDetail: evidence.navigationFailureDetail ?? 'Browser navigation failed.',
        };
    }

    if (evidence.statusCode === 451) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.GeoBlocked,
            fallbackDetail: 'The main document returned HTTP 451.',
        };
    }

    if (evidence.statusCode >= 400) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.HttpBlocked,
            fallbackDetail: `The main document returned HTTP ${evidence.statusCode}.`,
        };
    }

    const withheld = classifyWithheldPageText(evidence);
    if (withheld === BrowserFallbackReason.GeoBlocked) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.GeoBlocked,
            fallbackDetail: 'The page content indicates a regional availability block.',
        };
    }

    if (withheld === BrowserFallbackReason.BotChallenge) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.BotChallenge,
            fallbackDetail: 'The page content indicates an anti-bot challenge.',
        };
    }

    if (evidence.htmlLength < 256 && evidence.visibleTextPreview.trim().length === 0) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.EmptyDom,
            fallbackDetail: 'The captured page contains no DOM or visible text.',
        };
    }

    if (!evidence.screenshotArtifactId || !evidence.domArtifactId || !evidence.harArtifactId) {
        return {
            usable: false,
            fallbackReason: BrowserFallbackReason.ArtifactCaptureFailed,
            fallbackDetail: 'Browser preflight did not produce every required artifact.',
        };
    }

    return {
        usable: true,
        fallbackReason: null,
        fallbackDetail: null,
    };
}

/**
 * Resolve the effective run mode while enforcing browser-first fallback policy.
 *
 * @param requestedMode - Browser mode selected by the caller.
 * @param browserUsable - Whether preflight produced usable live evidence.
 * @returns The effective mode and whether reasoning fallback is permitted.
 */
export function resolveBrowserMode(
    requestedMode: BrowserMode,
    browserUsable: boolean,
): BrowserModeResolution {
    if (requestedMode === BrowserMode.Off) {
        return { effectiveMode: EffectiveMode.Reasoning, mayUseReasoningFallback: false };
    }
    if (browserUsable) {
        return { effectiveMode: EffectiveMode.Browser, mayUseReasoningFallback: false };
    }
    if (requestedMode === BrowserMode.Auto) {
        return { effectiveMode: EffectiveMode.Reasoning, mayUseReasoningFallback: true };
    }
    return { effectiveMode: EffectiveMode.Browser, mayUseReasoningFallback: false };
}

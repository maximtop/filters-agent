import * as v from 'valibot';
import {
    classifyBrowserPreflight,
    classifyWithheldPageText,
    type BrowserPreflightEvidence,
} from '../analyzer/browser-first-run';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * Finite statement about whether a page can carry a reproduction claim.
 */
export const TargetAccessClassification = {
    /**
     * The page loaded normally and carries no access obstruction.
     */
    Accessible: 'accessible',

    /**
     * The host did not resolve, accept a connection, or answer within the runner's budget.
     */
    Unreachable: 'unreachable',

    /**
     * The target withheld the page on regional grounds.
     */
    RegionRestricted: 'region_restricted',

    /**
     * The page is gated behind a login wall or an authentication-required response.
     */
    AuthenticationRequired: 'authentication_required',

    /**
     * The target served an anti-bot challenge instead of the page.
     */
    BotChallenge: 'bot_challenge',

    /**
     * The target answered with a server-side error status the other classifications don't cover.
     */
    ServerError: 'server_error',

    /**
     * The target served no usable content for the reported page.
     */
    ContentAbsent: 'content_absent',

    /**
     * We declined to navigate; this records that we never looked, not a claim about the page.
     */
    AgentDeclined: 'agent_declined',
} as const;

/**
 * Every TargetAccessClassification value, for schemas and exhaustive listings.
 */
export const TARGET_ACCESS_CLASSIFICATION_VALUES = Object.values(TargetAccessClassification);

/**
 * TargetAccessClassification value.
 */
export type TargetAccessClassification =
    (typeof TargetAccessClassification)[keyof typeof TargetAccessClassification];

export const TargetAccessClassificationSchema = v.picklist(TARGET_ACCESS_CLASSIFICATION_VALUES);

/**
 * Access meaning of every technical fallback the shared preflight can report.
 *
 * `http_blocked` is deliberately absent: it collapses statuses whose access meanings differ, so it
 * is decided from the status itself rather than from the fallback name.
 *
 * `agent_declined` is not a claim about the page. It records that we never looked, which is what
 * every consumer here needs — none of them may treat such a session as a reproduction — without
 * asserting anything about the reporter's site.
 */
const ACCESS_BY_FALLBACK: Readonly<
    Record<
        Exclude<BrowserFallbackReason, typeof BrowserFallbackReason.HttpBlocked>,
        TargetAccessClassification
    >
> = Object.freeze({
    [BrowserFallbackReason.GeoBlocked]: TargetAccessClassification.RegionRestricted,
    [BrowserFallbackReason.BotChallenge]: TargetAccessClassification.BotChallenge,
    [BrowserFallbackReason.EmptyDom]: TargetAccessClassification.ContentAbsent,
    [BrowserFallbackReason.NotFound]: TargetAccessClassification.ContentAbsent,
    [BrowserFallbackReason.TargetUnreachable]: TargetAccessClassification.Unreachable,
    [BrowserFallbackReason.NavigationTimeout]: TargetAccessClassification.Unreachable,
    [BrowserFallbackReason.TargetDnsUnresolved]: TargetAccessClassification.Unreachable,
    [BrowserFallbackReason.NavigationOffOrigin]: TargetAccessClassification.AgentDeclined,
    [BrowserFallbackReason.UnsafeTargetUrl]: TargetAccessClassification.AgentDeclined,
    [BrowserFallbackReason.LaunchFailed]: TargetAccessClassification.Unreachable,
    [BrowserFallbackReason.ArtifactCaptureFailed]: TargetAccessClassification.Unreachable,
    [BrowserFallbackReason.ExtensionConfigurationFailed]: TargetAccessClassification.Unreachable,
});

/**
 * Text a page shows when it withholds the reported content behind an account.
 *
 * English-only on purpose, and it fails toward `accessible`: a missed login wall becomes an
 * ordinary observation whose reported symptom is then absent, which can never read as a
 * reproduction.
 */
const AUTHENTICATION_WALL_RE =
    /sign in to continue|log in to continue|please (?:sign|log) in|members? only|subscribers? only/i;

/**
 * Decide whether one observed page can carry a reproduction claim.
 *
 * Deterministic on purpose: an access decision that a model can be argued out of is exactly the
 * failure mode that lets an unreachable, gated, or emptied page be reported as a reproduction.
 *
 * @param evidence - Navigation, status, text and artifact facts from one browser phase.
 * @returns Exactly one finite access classification.
 */
export function classifyTargetAccess(
    evidence: BrowserPreflightEvidence,
): TargetAccessClassification {
    const preflight = classifyBrowserPreflight(evidence);
    if (
        preflight.fallbackReason !== null &&
        preflight.fallbackReason !== BrowserFallbackReason.HttpBlocked
    ) {
        return ACCESS_BY_FALLBACK[preflight.fallbackReason];
    }
    if (preflight.fallbackReason === BrowserFallbackReason.HttpBlocked) {
        if (evidence.statusCode === 401 || evidence.statusCode === 403) {
            return TargetAccessClassification.AuthenticationRequired;
        }
        if (evidence.statusCode === 404 || evidence.statusCode === 410) {
            return TargetAccessClassification.ContentAbsent;
        }
        return TargetAccessClassification.ServerError;
    }
    // Regional blocks and bot challenges already returned above, so this detector cannot claim a
    // page either of them owns.
    if (AUTHENTICATION_WALL_RE.test(`${evidence.title}\n${evidence.visibleTextPreview}`)) {
        return TargetAccessClassification.AuthenticationRequired;
    }
    return TargetAccessClassification.Accessible;
}

/**
 * Decide whether one observed page could carry a reproduction claim, from navigation and text facts
 * alone.
 *
 * A browser session inside a run holds these facts but never assembles a preflight capture, so it
 * cannot use {@link classifyTargetAccess} without inventing artifact identities. Both entry points
 * share one set of detectors, so a login wall or a regional block means the same thing wherever it
 * is observed.
 *
 * @param evidence - Status, title and visible text observed after navigation.
 * @returns Exactly one finite access classification.
 */
export function classifyObservedPageAccess(
    evidence: Pick<BrowserPreflightEvidence, 'statusCode' | 'title' | 'visibleTextPreview'>,
): TargetAccessClassification {
    if (evidence.statusCode === 451) {
        return TargetAccessClassification.RegionRestricted;
    }
    if (evidence.statusCode === 401 || evidence.statusCode === 403) {
        return TargetAccessClassification.AuthenticationRequired;
    }
    if (evidence.statusCode === 404 || evidence.statusCode === 410) {
        return TargetAccessClassification.ContentAbsent;
    }
    if (evidence.statusCode >= 400) {
        return TargetAccessClassification.ServerError;
    }
    const withheld = classifyWithheldPageText(evidence);
    if (withheld !== null) {
        return ACCESS_BY_FALLBACK[withheld];
    }
    if (AUTHENTICATION_WALL_RE.test(`${evidence.title}\n${evidence.visibleTextPreview}`)) {
        return TargetAccessClassification.AuthenticationRequired;
    }
    return TargetAccessClassification.Accessible;
}

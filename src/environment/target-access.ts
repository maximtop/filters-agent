import { PageObstruction } from '../types/page-obstruction';

/**
 * Finite statement about whether a page can carry a reproduction claim.
 */
export const TargetAccessClassification = {
    /**
     * The page loaded normally and carries no access obstruction.
     */
    Accessible: 'accessible',

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
} as const;

/**
 * TargetAccessClassification value.
 */
export type TargetAccessClassification =
    (typeof TargetAccessClassification)[keyof typeof TargetAccessClassification];

/**
 * What each vision verdict about a capture means for access to the reported page.
 */
const ACCESS_BY_OBSTRUCTION: Readonly<Record<PageObstruction, TargetAccessClassification>> =
    Object.freeze({
        [PageObstruction.None]: TargetAccessClassification.Accessible,
        [PageObstruction.AntiBotChallenge]: TargetAccessClassification.BotChallenge,
        [PageObstruction.SignInWall]: TargetAccessClassification.AuthenticationRequired,
        [PageObstruction.RegionBlock]: TargetAccessClassification.RegionRestricted,
        [PageObstruction.ErrorOrBlank]: TargetAccessClassification.ContentAbsent,
    });

/**
 * Decide whether one observed page could carry a reproduction claim.
 *
 * The main document's status is the browser's own fact. What the page showed in the reported
 * content's place is the vision verdict on the capture the claim rests on: page-text patterns used
 * to decide that half and missed every wording they did not list — pluto.tv's "not available in
 * your location" passed as not reproduced (#241958, 2026-09-23) — while the model that reads the
 * pixels names a sign-in wall or a regional block in any language.
 *
 * @param statusCode - HTTP status of the main document the session's navigation loaded.
 * @param obstruction - Vision verdict on what stood in place of the site's content.
 * @returns Exactly one finite access classification.
 */
export function classifyObservedPageAccess(
    statusCode: number,
    obstruction: PageObstruction,
): TargetAccessClassification {
    if (statusCode === 451) {
        return TargetAccessClassification.RegionRestricted;
    }
    if (statusCode === 401 || statusCode === 403) {
        return TargetAccessClassification.AuthenticationRequired;
    }
    if (statusCode === 404 || statusCode === 410) {
        return TargetAccessClassification.ContentAbsent;
    }
    if (statusCode >= 400) {
        return TargetAccessClassification.ServerError;
    }
    return ACCESS_BY_OBSTRUCTION[obstruction];
}

import { FindingType, type Finding } from '../types/site-analysis';
import { ReproductionSignal } from '../types/replay';

/**
 * The decoupled drift signal carried on {@link ReplayComparison}.
 *
 * - 'true' — the site still reproduces the ad (browser ran and an ad finding was reported).
 * - 'false' — the site has drifted / the ad no longer reproduces (browser ran, no ad finding).
 * - 'n/a' — no browser signal available (reasoning-only fallback or launch failure).
 */
export type { ReproductionSignal } from '../types/replay';

/**
 * Derive the reproduction signal from the agent's accumulated findings, decoupled from patch
 * grading (the rubric on the agent's proposed rules).
 *
 * A drifted site yields no `ad` finding, so the agent never reaches `apply_rule` for it — the
 * findings accumulator is the cleanest "did the ad reproduce on the live site" signal. The HITL
 * operator reviews the labeling to catch the edge case where the agent failed to report a finding
 * it should have.
 *
 * @param findings - The findings accumulated by the `SiteAnalyzer` during the browser run.
 * @param browserAvailable - Whether a browser session was constructed and used.
 * @returns 'true' when an ad finding was reported, 'false' when the browser ran with no ad finding,
 *   'n/a' when no browser signal exists.
 */
export function deriveReproductionSignal(
    findings: Finding[],
    browserAvailable: boolean,
): ReproductionSignal {
    if (!browserAvailable) {
        return ReproductionSignal.NotAssessed;
    }
    return findings.some((f) => f.type === FindingType.Ad)
        ? ReproductionSignal.Reproduced
        : ReproductionSignal.Drifted;
}

import { ReproductionSignal, type ReplayComparison } from '../types/replay';

/**
 * Aggregate agreement-rate view over a set of replay comparisons (SC-011).
 *
 * Reproduction-miss cases (`reproduced === 'false'`) are excluded from the denominator and reported
 * separately. Not-assessed cases (`reproduced === 'n/a'`, reasoning-only fallback) are also
 * excluded from the denominator — SC-011 scopes the rate to "where the site still reproduces."
 */
export interface AgreementRate {
    /**
     * Total number of comparisons passed in.
     */
    total: number;

    /**
     * Comparisons where the site reproduced the ad (`reproduced === 'true'`) — the SC-011
     * denominator.
     */
    eligible: number;

    /**
     * Comparisons where the site drifted (`reproduced === 'false'`); excluded from the rate.
     */
    reproductionMiss: number;

    /**
     * Comparisons with no browser signal (`reproduced === 'n/a'`); excluded from the rate.
     */
    notAssessed: number;

    /**
     * Eligible comparisons whose judge verdict is `equivalent`.
     */
    equivalent: number;

    /**
     * Share of eligible cases judged equivalent: `equivalent / eligible` (0 when eligible is 0).
     */
    rate: number;
}

/**
 * Compute the agreement rate over a set of replay comparisons.
 *
 * Pure, no I/O. Reproduction-miss and not-assessed cases are excluded from the denominator and
 * reported in their own counters (SC-011: "Reproduction-miss cases are reported separately and
 * excluded from this rate").
 *
 * @param comparisons - The replay comparisons to aggregate.
 * @returns The agreement-rate summary.
 */
export function computeAgreementRate(comparisons: ReplayComparison[]): AgreementRate {
    let eligible = 0;
    let reproductionMiss = 0;
    let notAssessed = 0;
    let equivalent = 0;

    for (const c of comparisons) {
        if (c.reproduced === ReproductionSignal.Reproduced) {
            eligible += 1;
            if (c.judgeVerdict.verdict === 'equivalent') {
                equivalent += 1;
            }
        } else if (c.reproduced === ReproductionSignal.Drifted) {
            reproductionMiss += 1;
        } else {
            notAssessed += 1;
        }
    }

    return {
        total: comparisons.length,
        eligible,
        reproductionMiss,
        notAssessed,
        equivalent,
        rate: eligible === 0 ? 0 : equivalent / eligible,
    };
}

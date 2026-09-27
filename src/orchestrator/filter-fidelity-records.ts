/**
 * How a run records that its executor reproduced the reporter's filter selection only
 * approximately. Without these records the run report would silently imply the reporter's exact
 * configuration was executed when the extension build's catalog, or the CLI's, could not offer
 * every filter the reporter had enabled.
 */
import {
    EnvironmentSelectionReservedCase,
    type EnvironmentSelectionHost,
} from '../environment/environment-selection';
import { BrowserExtensionExecutorName } from '../environment/executor-name';
import type { MissingCatalogFilterClassification } from '../environment/third-party-filter-catalog';
import type { EvidenceRouteSnapshot } from '../local/evidence-route-contract';

/**
 * The official Base filter (ID 2) every CLI evidence route enables, listed first among the
 * reproduced filters because the route's snapshot names it by a flag rather than by id.
 */
const BASE_FILTER_ID = 2;

/**
 * Publish how closely the extension route reproduced the reporter's filter selection.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param conflicts - Requested filters dropped from the expected set during the degraded import.
 */
export function recordExtensionFilterFidelity(
    environmentHost: EnvironmentSelectionHost,
    conflicts: readonly MissingCatalogFilterClassification[],
): void {
    const detail = conflicts
        .map((conflict) =>
            conflict.name === undefined
                ? String(conflict.filterId)
                : `${conflict.filterId} (${conflict.name})`,
        )
        .join(', ');
    try {
        environmentHost.recordFilterSelectionApproximation(
            BrowserExtensionExecutorName,
            'The installed extension build catalog does not list every filter the reporter ' +
                `had enabled. Skipped during import: ${detail}.`,
        );
    } catch {
        // A lock that moved on is not worth failing a live session over.
    }
}

/**
 * Publish how closely the activated evidence route reproduced the reporter's filter selection.
 *
 * @param environmentHost - The run's environment-selection host the record lands in.
 * @param snapshot - The evidence route's own snapshot, when a route is active.
 */
export function recordEvidenceRouteFilterFidelity(
    environmentHost: EnvironmentSelectionHost,
    snapshot: EvidenceRouteSnapshot | undefined,
): void {
    const kind = environmentHost.snapshot()?.selectedKind;
    if (
        !snapshot ||
        snapshot.unavailableFilterIds.length === 0 ||
        !kind ||
        kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
    ) {
        return;
    }
    try {
        environmentHost.recordFilterSelectionApproximation(
            kind,
            `The executor's catalog did not offer every filter the reporter had enabled. ` +
                `Reproduced official filters: ${[BASE_FILTER_ID, ...snapshot.reproducedFilterIds].join(', ')}. ` +
                `Unavailable: ${snapshot.unavailableFilterIds.join(', ')}.`,
        );
    } catch {
        // A lock that moved on is not worth failing a live session over.
    }
}

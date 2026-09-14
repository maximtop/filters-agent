import {
    MAX_SCANNED_SURFACES,
    MAX_SURFACE_FACT_LENGTH,
    MAX_SURFACE_STACK_ORDER,
    type AnnoyanceSurfaceFacts,
    type AnnoyanceSurfaceScan,
} from '../environment/annoyance-target';
import type { IBrowserSession } from './browser-interfaces';
import { encodeProbeInput, factNumber, factString } from './page-probe-transport';
import { createTrustedPageEvaluator } from './trusted-page-evaluator';

/**
 * Most element nodes one scan inspects, matching the bounded slice the interaction runner uses.
 */
const MAX_SCANNED_NODES = 1_500;

/**
 * Smallest share of the viewport a surface must cover to be recorded as an obstruction.
 *
 * Deliberately lower than the interaction runner's obstruction threshold: a bottom consent bar is a
 * reported annoyance long before it covers a fifth of the screen.
 */
const MIN_SURFACE_COVERAGE = 0.05;

/**
 * Positioning modes that lift a surface out of the document flow and over the content.
 */
const OBSTRUCTING_POSITION_MODES: readonly AnnoyanceSurfaceFacts['positionMode'][] = [
    'fixed',
    'sticky',
    'absolute',
];

/**
 * Build the fixed expression that enumerates the obstructing surfaces of the current page.
 *
 * @returns Runner-owned browser expression containing no caller-authored source.
 */
function buildAnnoyanceSurfaceProbe(): string {
    const encodedInput = encodeProbeInput({
        nodeLimit: MAX_SCANNED_NODES,
        maxSurfaces: MAX_SCANNED_SURFACES,
        maxFactLength: MAX_SURFACE_FACT_LENGTH,
        maxStackOrder: MAX_SURFACE_STACK_ORDER,
        minCoverage: MIN_SURFACE_COVERAGE,
    });
    return `
(function () {
    var marker = '__adguard_annoyance_surface_probe__';
    var input = JSON.parse(atob('${encodedInput}'));
    var bounded = function (value, max) {
        return String(value === null || value === undefined ? '' : value).slice(0, max);
    };
    var viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    var centerX = window.innerWidth / 2;
    var centerY = window.innerHeight / 2;
    var nodes = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, input.nodeLimit);
    var surfaces = [];
    for (var index = 0; index < nodes.length; index++) {
        var node = nodes[index];
        var style = getComputedStyle(node);
        if (style.position !== 'fixed' && style.position !== 'sticky' &&
            style.position !== 'absolute') continue;
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
            continue;
        }
        var rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        var coverage = (rect.width * rect.height) / viewportArea;
        if (coverage < input.minCoverage) continue;
        var stackOrder = parseInt(style.zIndex, 10);
        surfaces.push({
            tagName: bounded(node.tagName, input.maxFactLength).toLocaleLowerCase(),
            elementId: bounded(node.id, input.maxFactLength),
            elementClasses: bounded(node.getAttribute('class'), input.maxFactLength),
            elementRole: bounded(node.getAttribute('role'), input.maxFactLength),
            accessibleLabel: bounded(
                String(node.getAttribute('aria-label') || node.textContent || '')
                    .replace(/\\s+/g, ' ').trim(),
                input.maxFactLength
            ),
            positionMode: style.position,
            stackOrder: isFinite(stackOrder)
                ? Math.max(0, Math.min(input.maxStackOrder, stackOrder))
                : 0,
            viewportCoverage: Math.round(Math.min(1, coverage) * 1000),
            coversViewportCenter: rect.left <= centerX && rect.right >= centerX &&
                rect.top <= centerY && rect.bottom >= centerY
        });
    }
    surfaces.sort(function (left, right) {
        return right.viewportCoverage - left.viewportCoverage;
    });
    var documentStyle = getComputedStyle(document.documentElement);
    var bodyStyle = getComputedStyle(document.body);
    return {
        marker: marker,
        surfaces: surfaces.slice(0, input.maxSurfaces),
        surfaceCount: surfaces.length,
        scrollLocked: bodyStyle.overflow === 'hidden' || documentStyle.overflow === 'hidden' ||
            bodyStyle.position === 'fixed',
        documentHeight: Math.round(document.documentElement.scrollHeight || 0)
    };
})()
`;
}

/**
 * Fixed runner-owned expression every phase evaluates unchanged.
 */
const ANNOYANCE_SURFACE_PROBE = buildAnnoyanceSurfaceProbe();

/**
 * Clamp one probe number into its hard range.
 *
 * @param value - Raw probe field.
 * @param maximum - Highest value the entity allows.
 * @returns Non-negative integer inside the hard range.
 */
function boundedCount(value: unknown, maximum: number): number {
    return Math.min(maximum, factNumber(value));
}

/**
 * Convert one raw probe entry into bounded surface facts.
 *
 * @param raw - One entry of the probe's surface list.
 * @returns Bounded facts, or null when the entry describes nothing that obstructs the page.
 */
function readSurfaceFacts(raw: unknown): AnnoyanceSurfaceFacts | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const entry = raw as Record<string, unknown>;
    const positionMode = OBSTRUCTING_POSITION_MODES.find((mode) => mode === entry.positionMode);
    // A surface in the ordinary document flow obstructs nothing, so it is never annoyance
    // evidence, and a positioning mode that cannot be read has not been established either.
    if (!positionMode) {
        return null;
    }
    return {
        tagName: factString(entry.tagName, MAX_SURFACE_FACT_LENGTH),
        elementId: factString(entry.elementId, MAX_SURFACE_FACT_LENGTH),
        elementClasses: factString(entry.elementClasses, MAX_SURFACE_FACT_LENGTH),
        elementRole: factString(entry.elementRole, MAX_SURFACE_FACT_LENGTH),
        accessibleLabel: factString(entry.accessibleLabel, MAX_SURFACE_FACT_LENGTH),
        positionMode,
        stackOrder: boundedCount(entry.stackOrder, MAX_SURFACE_STACK_ORDER),
        viewportCoverage: boundedCount(entry.viewportCoverage, 1_000),
        coversViewportCenter: entry.coversViewportCenter === true,
    };
}

/**
 * Convert one raw probe result into a bounded ordered scan.
 *
 * @param raw - Value the isolated-world probe returned.
 * @returns Bounded scan, or null when the result carried no surface list at all.
 */
function readSurfaceScan(raw: unknown): AnnoyanceSurfaceScan | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const result = raw as Record<string, unknown>;
    if (!Array.isArray(result.surfaces)) {
        return null;
    }
    const surfaces = result.surfaces
        .map(readSurfaceFacts)
        .filter((facts): facts is AnnoyanceSurfaceFacts => facts !== null);
    // oxlint-disable-next-line unicorn/no-array-sort -- ES2023 toSorted is outside this target.
    surfaces.sort((left, right) => right.viewportCoverage - left.viewportCoverage);
    return {
        surfaces: surfaces.slice(0, MAX_SCANNED_SURFACES),
        surfaceCount: Math.max(surfaces.length, factNumber(result.surfaceCount)),
        scrollLocked: result.scrollLocked === true,
        documentHeight: factNumber(result.documentHeight),
    };
}

/**
 * Scan the interacted page for the obstructing surfaces an annoyance presents as.
 *
 * The expression is fixed and runner-owned, evaluated in an isolated world so site JavaScript
 * cannot forge the facts the correlation reads. Every failure path returns null rather than an
 * empty scan: "no obstruction" and "could not look" must never collapse into one another.
 *
 * @param session - Adapter-established browser session for this phase.
 * @returns Bounded ordered scan, or null when the page could not be scanned.
 */
export async function probeAnnoyanceSurfaces(
    session: IBrowserSession,
): Promise<AnnoyanceSurfaceScan | null> {
    try {
        const evaluator = await createTrustedPageEvaluator(session.getPage());
        return readSurfaceScan(await evaluator.evaluate(ANNOYANCE_SURFACE_PROBE));
    } catch {
        return null;
    }
}

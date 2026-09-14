import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as v from 'valibot';
import {
    PlacementMapSchema,
    type PlacementMap,
    type FilterFileEntry,
    type FilterSection,
} from '../types/repo-context';

/**
 * Directories skipped during checkout traversal.
 */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * Recursively collect `.txt` file paths under a root.
 *
 * @param root - Directory to walk.
 * @returns Absolute paths of all `.txt` files.
 */
function collectTxtFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        if (SKIP_DIRS.has(entry)) {
            continue;
        }
        const full = join(root, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            results.push(...collectTxtFiles(full));
        } else if (entry.endsWith('.txt')) {
            results.push(full);
        }
    }
    return results;
}

/**
 * Derive a filter name from a file's path relative to the checkout root.
 *
 * Uses the top-level directory segment (e.g. `BaseFilter/filter.txt` → `BaseFilter`).
 *
 * @param relPath - Path relative to the checkout root.
 * @returns The filter name.
 */
function filterNameFromRelPath(relPath: string): string {
    const firstSep = relPath.indexOf(sep);
    return firstSep === -1 ? relPath : relPath.slice(0, firstSep);
}

/**
 * Detect sections in a filter file from `! Section: <name>` headers.
 *
 * Rules before the first header belong to a section named after the `! Title:` comment (fallback
 * `"default"`). `endLine` is inclusive.
 *
 * @param lines - All lines of the file (1-based indexing applied by caller).
 * @param title - The file title if a `! Title:` comment was found.
 * @returns Detected sections.
 */
function detectSections(lines: string[], title: string | undefined): FilterSection[] {
    const sections: FilterSection[] = [];
    let current: FilterSection | undefined;
    const flush = (endLine: number) => {
        if (current) {
            current.endLine = endLine;
            sections.push(current);
        }
    };
    lines.forEach((line, idx) => {
        const lineNo = idx + 1;
        const sectionMatch = line.match(/^!\s*Section:\s*(.+?)\s*$/i);
        if (sectionMatch) {
            flush(lineNo - 1);
            current = { name: sectionMatch[1], startLine: lineNo + 1, endLine: lineNo };
        }
    });
    flush(lines.length);
    if (sections.length === 0) {
        sections.push({
            name: title ?? 'default',
            startLine: 1,
            endLine: lines.length,
        });
    }
    return sections;
}

/**
 * Extract the `! Title:` value from a file's lines, if present.
 *
 * @param lines - All lines of the file.
 * @returns The title text or undefined.
 */
function extractTitle(lines: string[]): string | undefined {
    for (const line of lines) {
        const m = line.match(/^!\s*Title:\s*(.+?)\s*$/i);
        if (m) {
            return m[1];
        }
    }
    return undefined;
}

/**
 * Generate a placement map by scanning an AdguardFilters checkout.
 *
 * @param checkoutPath - Absolute path to the local AdguardFilters checkout.
 * @returns The generated placement map.
 */
export function generatePlacementMap(checkoutPath: string): PlacementMap {
    const files = collectTxtFiles(checkoutPath)
        .sort()
        .map((absPath): FilterFileEntry => {
            const relPath = relative(checkoutPath, absPath);
            const lines = readFileSync(absPath, 'utf8').split(/\r?\n/);
            const title = extractTitle(lines);
            const sections = detectSections(lines, title);
            return {
                filter: filterNameFromRelPath(relPath),
                relativePath: relPath,
                sections,
            };
        });
    const map = {
        checkoutPath,
        generatedAt: new Date().toISOString(),
        files,
    };
    return v.parse(PlacementMapSchema, map);
}

/**
 * Write a placement map to a JSON file.
 *
 * @param map - The map to write.
 * @param outPath - Output path (defaults to `placement-map.json` in the checkout root).
 */
export function writePlacementMap(map: PlacementMap, outPath?: string): void {
    const target = outPath ?? join(map.checkoutPath, 'placement-map.json');
    writeFileSync(target, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

/**
 * Load and validate a previously-written placement-map.json.
 *
 * @param jsonPath - Path to the JSON file.
 * @returns The validated placement map.
 */
export function loadPlacementMap(jsonPath: string): PlacementMap {
    if (!existsSync(jsonPath)) {
        throw new Error(`Placement map not found: ${jsonPath}`);
    }
    const raw = readFileSync(jsonPath, 'utf8');
    return v.parse(PlacementMapSchema, JSON.parse(raw));
}

/**
 * Issue labels a run never processes.
 *
 * A filter repository names them through the action's `excludedLabels` input, for example the label
 * it puts on reports about adult sites: the run would otherwise open the reported page in a browser
 * and commit its screenshots to the repository. GitHub treats label names case-insensitively, so
 * the comparison does too.
 */

/**
 * Separator between the labels of the `excludedLabels` input.
 */
const EXCLUDED_LABELS_SEPARATOR = ',';

/**
 * Parse the comma-separated `excludedLabels` value.
 *
 * @param raw - The input value, or undefined when unset.
 * @returns The trimmed labels, blank entries dropped; empty when nothing is excluded.
 */
export function parseExcludedLabels(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(EXCLUDED_LABELS_SEPARATOR)
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
}

/**
 * Pick the issue's labels the run excludes.
 *
 * @param issueLabels - Labels the issue carries now.
 * @param excludedLabels - Labels the run never processes.
 * @returns The matching labels in the issue's own spelling; empty when none matches.
 */
export function excludedIssueLabels(
    issueLabels: readonly string[],
    excludedLabels: readonly string[],
): string[] {
    const excluded = new Set(excludedLabels.map((label) => label.toLowerCase()));
    return issueLabels.filter((label) => excluded.has(label.toLowerCase()));
}

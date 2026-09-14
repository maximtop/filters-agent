import { createHash } from 'node:crypto';

/**
 * Instruction-section extraction.
 *
 * Decision (b) of the issue plan: an instruction may carry exactly one preparation task under a
 * fixed English keyword heading, and its whole body rides the preparation session verbatim — fenced
 * shell text inside the body is the steps. An instruction without such a heading simply means "no
 * model preparation": the host falls back to the pinned prebuilt release download and the missing
 * section is never a failure. The heading/fence walk below is shared with the other instruction
 * roles (issue selection), which reuse extraction by passing their own keywords.
 */

/**
 * Keywords binding a Markdown `##` heading to the preparation role, checked case-insensitively in
 * the heading text.
 *
 * Mirrors the role-keyword binding shape of the instruction loader's guidance role keywords: the
 * instruction author names the role naturally ("Preparation", "Preparation steps for uBlock
 * Origin") and the binding stays fixed on these keywords.
 */
const PREPARATION_SECTION_KEYWORDS = ['preparation'] as const;

/**
 * Heading level whose line starts a new top-level section of the instruction.
 */
const SECTION_HEADING_LINE_PATTERN = /^##\s+(.*)$/;

/**
 * Line opening or closing a fenced code block; headings and keyword matching are inert inside
 * fenced blocks, whose text belongs to the preparation steps themselves.
 */
const FENCED_BLOCK_LINE_PATTERN = /^\s*```/;

/**
 * One instruction section bound to the preparation role.
 */
export interface PreparationSection {
    /**
     * Preparation task text exactly as written between the preparation heading and the next `##`
     * heading (or the end of the instruction), without the heading line itself.
     */
    content: string;

    /**
     * SHA-256 over the exact content bytes, so provenance can state what was prepared from.
     */
    sha256: string;
}

/**
 * Extract the heading text of one Markdown `##` line, if the line is one.
 *
 * @param line - One line of instruction text.
 * @returns The heading text without the marker, or undefined when the line is not a `##` heading.
 */
function headingTextOf(line: string): string | undefined {
    const match = SECTION_HEADING_LINE_PATTERN.exec(line);
    return match === null ? undefined : (match[1] ?? '');
}

/**
 * Check whether one heading text binds one of the role keywords.
 *
 * @param headingText - Heading text without the `##` marker.
 * @param keywords - Role keywords, each matched as a case-insensitive substring of the heading.
 * @returns True when any keyword occurs in the heading, case-insensitively.
 */
function bindsRole(headingText: string, keywords: readonly string[]): boolean {
    const lowered = headingText.toLowerCase();
    return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

/**
 * Extract the body of the first `##` heading bound by one of `keywords`: the verbatim text up to
 * the next `##` heading or the end of the instruction.
 *
 * Contract: the first binding heading wins and the returned body is verbatim (a fenced `##` line
 * neither binds nor bounds, and fenced text inside the body is kept). A missing binding heading or
 * an empty (whitespace-only) body yields undefined — the caller takes its role's no-section path
 * and never fails the run.
 *
 * @param content - Instruction text as loaded.
 * @param keywords - Keywords binding a heading to the wanted role, checked case-insensitively.
 * @returns The section body exactly as written, or undefined when the instruction carries no
 *   non-empty section for the role.
 */
export function extractInstructionSection(
    content: string,
    keywords: readonly string[],
): string | undefined {
    const lines = content.split('\n');
    let insideFence = false;
    let sectionBodyLines: string[] | undefined;
    for (const line of lines) {
        if (FENCED_BLOCK_LINE_PATTERN.test(line)) {
            insideFence = !insideFence;
            if (sectionBodyLines !== undefined) {
                sectionBodyLines.push(line);
            }
            continue;
        }
        const headingText = insideFence ? undefined : headingTextOf(line);
        if (sectionBodyLines === undefined) {
            if (headingText !== undefined && bindsRole(headingText, keywords)) {
                sectionBodyLines = [];
            }
            continue;
        }
        if (headingText !== undefined) {
            break;
        }
        sectionBodyLines.push(line);
    }
    if (sectionBodyLines === undefined) {
        return undefined;
    }
    const sectionContent = sectionBodyLines.join('\n');
    if (sectionContent.trim().length === 0) {
        return undefined;
    }
    return sectionContent;
}

/**
 * Extract the instruction's preparation section: the body of the first `##` heading whose text
 * contains the preparation keyword, up to the next `##` heading or the end of the instruction.
 *
 * @param content - Instruction text as loaded.
 * @returns The preparation body with its SHA-256 over the exact bytes, or undefined when the
 *   instruction carries no non-empty preparation section.
 */
export function extractPreparationSection(content: string): PreparationSection | undefined {
    const sectionContent = extractInstructionSection(content, PREPARATION_SECTION_KEYWORDS);
    if (sectionContent === undefined) {
        return undefined;
    }
    return {
        content: sectionContent,
        sha256: createHash('sha256').update(sectionContent, 'utf8').digest('hex'),
    };
}

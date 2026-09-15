import {
    PromptRenderError,
    extractPlaceholders,
    renderTemplate,
    type PlaceholderValues,
} from '../prompts/template';
import type { DeclaredPlacement } from '../types/declared-placement';
import { unfencedInstructionLines } from './instruction-preparation';

/**
 * The `placement:` declaration one run instruction may carry: which file an accepted rule goes
 * into, and the comment line that precedes it.
 *
 * The repository, not the agent, knows where its rules live. The deterministic placement resolver
 * routes by language and section the way the AdGuard repository is laid out, which is the wrong
 * shape for a uAssets-style repository that appends every rule to the current year's file behind a
 * comment naming the issue: in run 34996815226 it answered `filters/annoyances-cookies.txt` for an
 * ad-network rule because `TurkishFilter` was absent from the uAssets placement map. An instruction
 * that declares its placement takes that decision away from the routing.
 *
 * The declaration is one line, in the same shape as the `read:` and `launch:` declarations:
 * `placement: <path template> [comment: <comment template>]`. The path template may carry
 * `{{year}}`, the comment template `{{issueUrl}}`; no comment part means no comment line.
 */

/**
 * Placeholder names a placement declaration may carry, so the parser validates and the renderer
 * fills the same two names.
 */
export const PlacementPlaceholder = {
    /**
     * Four-digit current year, in UTC, filled when the run renders the declared path.
     */
    Year: 'year',

    /**
     * Web URL of the issue the run is fixing, filled into the declared comment line.
     */
    IssueUrl: 'issueUrl',
} as const;

/**
 * PlacementPlaceholder value.
 */
export type PlacementPlaceholder = (typeof PlacementPlaceholder)[keyof typeof PlacementPlaceholder];

/**
 * Placeholders the declared path template may carry.
 */
const PLACEMENT_PATH_PLACEHOLDERS: readonly PlacementPlaceholder[] = [PlacementPlaceholder.Year];

/**
 * Placeholders the declared comment template may carry.
 */
const PLACEMENT_COMMENT_PLACEHOLDERS: readonly PlacementPlaceholder[] = [
    PlacementPlaceholder.IssueUrl,
];

/**
 * The declaration grammar: the path template as one space-free token, optionally followed by the
 * `comment:` keyword and the comment template as the rest of the line.
 */
const PLACEMENT_DECLARATION_LINE_PATTERN = /^placement:\s*(\S+)(?:\s+comment:\s*(.*\S))?$/;

/**
 * Keyword a line must start with to be read as a placement declaration.
 */
const PLACEMENT_DECLARATION_KEYWORD = 'placement:';

/**
 * Character ceiling on the declared path template.
 *
 * A checkout-relative list path is short — the shipped `filters/filters-{{year}}.txt` is 27
 * characters — so the cap is generous for a nested layout while keeping an unbounded declaration
 * out of every answer that quotes the rendered path: the resolver result, the insertion plan, and
 * the published report.
 */
export const MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS = 200;

/**
 * Character ceiling on the declared comment template.
 *
 * The comment is one line of a filter list holding an issue URL; the same bound as the path keeps
 * one long declaration from reaching the file the run edits.
 */
export const MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS = 200;

/**
 * One malformed placement declaration, named so a failed instruction load says what is wrong.
 */
export class InstructionPlacementError extends Error {
    /**
     * Create one malformed-declaration failure.
     *
     * @param message - Full diagnostic quoting the offending declaration text.
     */
    constructor(message: string) {
        super(message);
        this.name = 'InstructionPlacementError';
    }
}

/**
 * The placement declaration exactly as the instruction writes it, before any rendering.
 */
export interface InstructionPlacement {
    /**
     * Checkout-relative path template of the file accepted rules go into, possibly carrying
     * `{{year}}`.
     */
    pathTemplate: string;

    /**
     * Template of the comment line written immediately before the rule, possibly carrying
     * `{{issueUrl}}`; absent when the declaration asks for no comment.
     */
    commentTemplate?: string;
}

/**
 * What one run fills a placement declaration's placeholders from.
 */
export interface PlacementRenderContext {
    /**
     * Moment the run renders the declaration; its UTC year fills `{{year}}`.
     */
    now: Date;

    /**
     * Web URL of the issue under investigation, filling `{{issueUrl}}`; absent when the caller
     * holds no issue, which is a failed render for a declaration that asks for the URL.
     */
    issueUrl?: string;
}

/**
 * Reject a path template that is not a relative checkout path.
 *
 * The declaration names a file inside the run's own checkout: an absolute path, a Windows
 * separator, or a `..` segment would send the edit outside it, so each is a named refusal rather
 * than a path the run tries to resolve.
 *
 * @param pathTemplate - Declared path template as written.
 * @throws {InstructionPlacementError} When the template is not a bounded relative checkout path.
 */
function assertRelativeCheckoutPath(pathTemplate: string): void {
    if (pathTemplate.length > MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS) {
        throw new InstructionPlacementError(
            `the declared path is ${pathTemplate.length} characters, above the ` +
                `${MAX_PLACEMENT_PATH_TEMPLATE_CHARACTERS}-character cap`,
        );
    }
    if (pathTemplate.startsWith('/') || /^[A-Za-z]:/.test(pathTemplate)) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' is absolute; declare it relative to the checkout`,
        );
    }
    if (pathTemplate.includes('\\')) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' carries a backslash; use '/' separators`,
        );
    }
    const segments = pathTemplate.split('/');
    if (segments.some((segment) => segment.length === 0)) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' carries an empty path segment`,
        );
    }
    if (segments.includes('..')) {
        throw new InstructionPlacementError(
            `the declared path '${pathTemplate}' escapes the checkout through '..'`,
        );
    }
}

/**
 * Reject a template carrying a placeholder the declaration does not support.
 *
 * @param template - Declared path or comment template.
 * @param allowed - Placeholders this template position supports.
 * @param position - Which part of the declaration is being checked, for the message.
 * @throws {InstructionPlacementError} For a malformed `{{` token or an unsupported placeholder.
 */
function assertSupportedPlaceholders(
    template: string,
    allowed: readonly PlacementPlaceholder[],
    position: string,
): void {
    let declared: string[];
    try {
        declared = extractPlaceholders(template, `placement ${position}`);
    } catch (error) {
        throw new InstructionPlacementError(
            error instanceof PromptRenderError ? error.message : String(error),
        );
    }
    for (const name of declared) {
        if (!(allowed as readonly string[]).includes(name)) {
            throw new InstructionPlacementError(
                `the declared ${position} carries the unsupported placeholder '{{${name}}}'; ` +
                    `it may use only ${allowed.map((value) => `{{${value}}}`).join(', ')}`,
            );
        }
    }
}

/**
 * Parse one declaration line into the declared placement.
 *
 * @param declarationLine - Trimmed instruction line starting with the declaration keyword.
 * @returns The declared placement.
 * @throws {InstructionPlacementError} When the line does not follow the grammar or carries an
 *   unusable path or comment template.
 */
function parseDeclarationLine(declarationLine: string): InstructionPlacement {
    const match = PLACEMENT_DECLARATION_LINE_PATTERN.exec(declarationLine);
    if (match === null) {
        throw new InstructionPlacementError(
            `the declaration '${declarationLine}' does not follow ` +
                '"placement: <path> [comment: <text>]"',
        );
    }
    const pathTemplate = match[1] ?? '';
    assertRelativeCheckoutPath(pathTemplate);
    assertSupportedPlaceholders(pathTemplate, PLACEMENT_PATH_PLACEHOLDERS, 'path');
    const commentTemplate = match[2];
    if (commentTemplate === undefined) {
        return { pathTemplate };
    }
    if (commentTemplate.length > MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS) {
        throw new InstructionPlacementError(
            `the declared comment is ${commentTemplate.length} characters, above the ` +
                `${MAX_PLACEMENT_COMMENT_TEMPLATE_CHARACTERS}-character cap`,
        );
    }
    assertSupportedPlaceholders(commentTemplate, PLACEMENT_COMMENT_PLACEHOLDERS, 'comment');
    return { pathTemplate, commentTemplate };
}

/**
 * Read the placement one run instruction declares.
 *
 * Contract: at most one declaration line anywhere outside a fenced block — fenced text is example
 * material, exactly as it is for the other declarations — and a line that opens with the keyword
 * but does not follow the grammar is a named failure, never a skipped line. An instruction that
 * declares no placement leaves the deterministic resolver in charge.
 *
 * @param content - Instruction text as loaded.
 * @returns The declared placement, or undefined when the instruction declares none.
 * @throws {InstructionPlacementError} For a second declaration or a malformed one.
 */
export function parseInstructionPlacement(content: string): InstructionPlacement | undefined {
    const declarationLines = unfencedInstructionLines(content).filter((line) =>
        line.startsWith(PLACEMENT_DECLARATION_KEYWORD),
    );
    if (declarationLines.length === 0) {
        return undefined;
    }
    if (declarationLines.length > 1) {
        throw new InstructionPlacementError(
            `the instruction carries ${declarationLines.length} placement declarations; one run ` +
                'sends its rules to one place, so declare it once',
        );
    }
    return parseDeclarationLine(declarationLines[0] as string);
}

/**
 * Render one template with exactly the placeholders it declares.
 *
 * The prompt renderer is strict in both directions, so the fills are narrowed to the template's own
 * placeholders: a declaration that names no placeholder renders verbatim, and one that names a
 * placeholder the run cannot fill fails named instead of rendering a hole.
 *
 * @param template - Declared path or comment template.
 * @param values - Values available for the supported placeholders.
 * @param position - Which part of the declaration is being rendered, for the message.
 * @returns The rendered text.
 */
function renderDeclaredTemplate(
    template: string,
    values: PlaceholderValues,
    position: string,
): string {
    const source = `placement ${position}`;
    const fills: PlaceholderValues = {};
    for (const name of extractPlaceholders(template, source)) {
        const value = values[name];
        if (value !== undefined) {
            fills[name] = value;
        }
    }
    return renderTemplate(template, fills, source);
}

/**
 * Render one run's declared placement: the exact file path and comment line this run would write.
 *
 * @param placement - The instruction's declaration as parsed at load.
 * @param context - Run facts filling the declaration's placeholders.
 * @returns The rendered placement the resolver answers with and the edit writes.
 * @throws {PromptRenderError} When the declaration names a placeholder the run cannot fill — a
 *   comment declaring `{{issueUrl}}` in a run that holds no issue URL.
 */
export function renderInstructionPlacement(
    placement: InstructionPlacement,
    context: PlacementRenderContext,
): DeclaredPlacement {
    const values: PlaceholderValues = {
        [PlacementPlaceholder.Year]: String(context.now.getUTCFullYear()),
        ...(context.issueUrl === undefined
            ? {}
            : { [PlacementPlaceholder.IssueUrl]: context.issueUrl }),
    };
    const filePath = renderDeclaredTemplate(placement.pathTemplate, values, 'path');
    if (placement.commentTemplate === undefined) {
        return { filePath };
    }
    return {
        filePath,
        commentLine: renderDeclaredTemplate(placement.commentTemplate, values, 'comment'),
    };
}

/**
 * Render the placement one run declares, as its whole run then uses it.
 *
 * The run renders its declaration exactly once, at start, and hands the rendered value to every
 * consumer — the `resolve_placement` tool, the candidate safety gate, and the patch the publication
 * builds. Rendering it again later would let a run that straddles a UTC new year answer with one
 * year's file and publish into another's.
 *
 * @param placement - The declaration parsed at instruction load, when the run carries one.
 * @param issueUrl - Web URL of the issue under investigation, filling `{{issueUrl}}`.
 * @returns The rendered placement, or undefined when the run declares none.
 * @throws {PromptRenderError} When the declaration names a placeholder the run cannot fill.
 */
export function declaredPlacementForRun(
    placement: InstructionPlacement | undefined,
    issueUrl: string | undefined,
): DeclaredPlacement | undefined {
    if (placement === undefined) {
        return undefined;
    }
    return renderInstructionPlacement(placement, {
        now: new Date(),
        ...(issueUrl === undefined ? {} : { issueUrl }),
    });
}

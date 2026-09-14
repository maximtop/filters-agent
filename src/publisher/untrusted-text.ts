/**
 * Untrusted-text slot of the Publisher.
 *
 * The bounded single-line escape every untrusted fill renders through — the machinery
 * `report-render.ts` builds its fills with, kept in its own module so the render plumbing stays
 * within its size budget. Comment bodies on GitHub sanitize most HTML, but the escape is defense in
 * depth: one reader-dependent renderer decides what `{{tokens}}` in a template become, so untrusted
 * text is escaped, flattened, and bounded before entering any fill.
 *
 * The escape is the one shared renderer for untrusted text in public comments — the same mapping
 * `lab/github/live-runtime-publisher.ts` applies to live fix-agent prose, so a public GitHub
 * comment and a private live summary neutralize model-authored text identically. Beyond the plain
 * HTML metacharacters, it also escapes `@` (mentions), `[`/`]` (links — and, since an image needs
 * the same literal brackets, images too) and `#` (both a leading-`#` Markdown heading and a bare
 * `owner/repo#123` cross-reference need a literal `#` to fire).
 */

/**
 * Character ceiling for one escaped untrusted fill in the report.
 *
 * Model-authored text is bounded, not dropped: a whole-sentence summary usually fits, and a longer
 * run still ends in the artifacts. 500 characters is the same order of bound the lab's outcome
 * renderer uses for agent reasoning.
 */
const MAX_UNTRUSTED_TEXT_CHARACTERS = 500;

/**
 * Marker appended when escaping stops at the character ceiling, so a truncated fill is visible.
 */
const TRUNCATION_MARK = '…';

/**
 * HTML entity replacements applied to untrusted text, one reserved character each.
 *
 * `@`, `[`, `]` and `#` are not HTML metacharacters, but each one is the literal character GitHub's
 * own Markdown needs to turn untrusted text into an active mention, link, image, cross-reference or
 * heading; escaping them here is defense in depth beside the template's plain-text placeholder
 * slots.
 */
const ESCAPED_CHARACTERS: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '@': '&#64;',
    '[': '&#91;',
    ']': '&#93;',
    '#': '&#35;',
};

/**
 * Escape one character of untrusted text for safe inclusion in the comment body.
 *
 * @param character - One Unicode character from the flattened source text.
 * @returns The HTML entity for a reserved character, else the character itself.
 */
function escapeUntrustedCharacter(character: string): string {
    return ESCAPED_CHARACTERS[character] ?? character;
}

/**
 * Escape every reserved character in untrusted text, without flattening or bounding it.
 *
 * The shared primitive behind {@link renderUntrustedText}'s bounded single-line rendering; a caller
 * with its own normalization and length bound (the lab's live-run summary, which allows longer
 * prose and wraps it in `<code>`/`<p>`) applies this directly instead of duplicating the character
 * map.
 *
 * @param input - Untrusted text, already normalized by the caller.
 * @returns The text with every reserved character replaced by its HTML entity.
 */
export function escapeReservedCharacters(input: string): string {
    return Array.from(input, escapeUntrustedCharacter).join('');
}

/**
 * Render untrusted model-authored text as bounded single-line escaped content.
 *
 * Why escaping and not plain inclusion: the text comes from the model and must never steer comment
 * structure (headings, marks, injected tags) no matter what it contains, and control characters
 * plus line breaks are dropped so the fill stays one line inside a `{{placeholder}}` slot. Why
 * bounding and not rejecting: the run's full text lives in the artifacts; the short report needs it
 * bounded, never absent.
 *
 * @param input - Raw model-authored text.
 * @returns Escaped single-line text at most `MAX_UNTRUSTED_TEXT_CHARACTERS` characters (ellipsis
 *   included), or the empty string for empty input.
 */
export function renderUntrustedText(input: string): string {
    const singleLine = input
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (singleLine.length === 0) {
        return '';
    }
    let escaped = '';
    let truncated = false;
    for (const character of singleLine) {
        const safeCharacter = escapeUntrustedCharacter(character);
        if (
            escaped.length + safeCharacter.length >
            MAX_UNTRUSTED_TEXT_CHARACTERS - TRUNCATION_MARK.length
        ) {
            truncated = true;
            break;
        }
        escaped += safeCharacter;
    }
    return truncated ? `${escaped}${TRUNCATION_MARK}` : escaped;
}

/**
 * Flatten untrusted text to one line without escaping it, bounded the same way
 * {@link renderUntrustedText} is — shared so a code-span renderer and the plain-text renderer
 * truncate identically.
 *
 * @param input - Raw untrusted text.
 * @returns The flattened, length-bounded text, unescaped.
 */
function flattenAndBoundUntrustedText(input: string): string {
    const singleLine = input
        .replace(/\p{Cc}+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (singleLine.length <= MAX_UNTRUSTED_TEXT_CHARACTERS) {
        return singleLine;
    }
    return (
        singleLine.slice(0, MAX_UNTRUSTED_TEXT_CHARACTERS - TRUNCATION_MARK.length) +
        TRUNCATION_MARK
    );
}

/**
 * Render a filter rule as a Markdown inline code span that cannot be broken out of.
 *
 * A rule is repository content, not model-authored prose, but it is still untrusted Markdown: an
 * AdGuard network rule wildcarding a path segment on both sides carries a bare asterisk on each
 * side of a slash, which CommonMark reads as a pair of emphasis markers unless the whole value
 * stays inside a code span. A code span's content is taken literally by the Markdown parser — no
 * character inside it needs HTML escaping — except for its own delimiter: a rule may itself contain
 * a run of backticks, and CommonMark only closes a span on a run of exactly the opening length, so
 * the fence must be one backtick longer than the longest run already inside the rule.
 *
 * @param rule - Raw filter rule text, single line.
 * @returns The bounded rule wrapped in a delimiter-safe inline code span, or the empty string for
 *   empty input.
 */
export function renderUntrustedRuleCodeSpan(rule: string): string {
    const flattened = flattenAndBoundUntrustedText(rule);
    if (flattened.length === 0) {
        return '';
    }
    const longestBacktickRun =
        flattened.match(/`+/gu)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
    const fence = '`'.repeat(longestBacktickRun + 1);
    const padded =
        flattened.startsWith('`') || flattened.endsWith('`') ? ` ${flattened} ` : flattened;
    return `${fence}${padded}${fence}`;
}

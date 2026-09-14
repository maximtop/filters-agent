import * as readline from 'node:readline';

/**
 * A function that prompts the user with a query string and resolves to their textual answer.
 */
export type PromptFn = (query: string) => Promise<string>;

/**
 * Default prompt implementation using Node.js `readline` on stdin/stdout.
 *
 * @param query - The prompt text to display.
 * @returns The user's answer string.
 */
const defaultPrompt: PromptFn = (query) => {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

/**
 * Replace C0/C1 control characters that could be used for terminal-control attacks on the consent
 * prompt (review finding 11). Tab (`\t` = 0x09) and newline (`\n` = 0x0a) are preserved because
 * they are legitimate formatting in the consent preview; all other C0 control chars (including NUL
 * 0x00, BEL 0x07, CR 0x0d carriage-return overwrite, and ESC 0x1b which leads ANSI sequences such
 * as `\x1b[2J` clear-screen or `\x1b]0;...\x07` title-spoof) plus the CSI introducer 0x9b are
 * replaced with `?` so the operator can see that redaction occurred.
 *
 * Defense-in-depth: the `description` is composed from LLM-authored text (rule body, PR body,
 * comment body) that an attacker can influence via issue content. `RuleProposalSchema.rule` is bare
 * `v.string()` at `src/types/rule-proposal.ts:44` — no control-char rejection — so sanitization
 * must happen at the consent surface.
 *
 * Implemented as a code-point scan rather than a control-character regex so the project's
 * `no-control-regex` lint rule is not tripped (matching control characters is the explicit intent
 * here).
 *
 * @param text - The raw prompt text.
 * @returns The text with C0/C1 control characters (except `\t` and `\n`) replaced by `?`.
 */
function sanitizePromptText(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (
            (code >= 0x00 && code <= 0x08) ||
            (code >= 0x0b && code <= 0x1f) ||
            code === 0x7f ||
            code === 0x9b
        ) {
            out += '?';
        } else {
            out += text[i];
        }
    }
    return out;
}

/**
 * Ask the operator for confirmation before an irreversible GitHub write.
 *
 * Displays the action description and accepts `y` / `yes` (case-insensitive, whitespace-trimmed) to
 * confirm; anything else (including empty input) denies. In `--dry-run` mode the caller must NOT
 * invoke this function at all.
 *
 * The `description` is sanitized via {@link sanitizePromptText} before it reaches `readline`, so
 * ANSI / C0 / C1 control characters planted in LLM-authored text cannot visually misrepresent the
 * content being authorized (finding 11).
 *
 * @param description - A human-readable description of what will be written.
 * @param prompt - Optional injected prompt function (for testing).
 * @returns `true` if the operator confirmed, `false` otherwise.
 */
export async function confirmAction(
    description: string,
    prompt: PromptFn = defaultPrompt,
): Promise<boolean> {
    const sanitized = sanitizePromptText(description);
    const answer = await prompt(`\n${sanitized}\nProceed? (y/N): `);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
}

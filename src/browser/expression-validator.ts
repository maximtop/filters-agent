/**
 * Read-only guard for evaluate_js expressions: blocks assignments, mutation methods, dynamic
 * imports, and other side-effecting constructs.
 */
/**
 * Literal patterns that are never valid in a read-only evaluate_js diagnostic.
 */
const DANGEROUS_PATTERNS = [
    'fetch(',
    'XMLHttpRequest',
    'document.cookie',
    'localStorage.',
    'sessionStorage.',
    'indexedDB',
    'location.href',
    'location.assign',
    'location.replace',
    'location.reload',
    'window.open',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'serviceWorker',
    'SharedWorker',
    'import(',
    'require(',
    'process.',
    'globalThis.',
];

/**
 * Methods that mutate DOM, browser, event, or observable page state.
 */
const MUTATING_METHOD_NAMES = [
    'addEventListener',
    'after',
    'animate',
    'append',
    'appendChild',
    'before',
    'blur',
    'click',
    'close',
    'deleteProperty',
    'deleteRule',
    'defineProperties',
    'defineProperty',
    'dispatchEvent',
    'execCommand',
    'focus',
    'insertAdjacentElement',
    'insertAdjacentHTML',
    'insertAdjacentText',
    'insertBefore',
    'insertRule',
    'observe',
    'pause',
    'play',
    'prepend',
    'pushState',
    'remove',
    'removeAttribute',
    'removeAttributeNS',
    'removeEventListener',
    'removeProperty',
    'replaceChild',
    'replaceChildren',
    'replaceState',
    'replaceSync',
    'replaceWith',
    'requestSubmit',
    'reset',
    'scroll',
    'scrollBy',
    'scrollIntoView',
    'scrollTo',
    'setAttribute',
    'setAttributeNS',
    'setPointerCapture',
    'setProperty',
    'setPrototypeOf',
    'show',
    'showModal',
    'submit',
    'write',
    'writeln',
];

/**
 * Global scheduling and dynamic-code APIs that can defer or hide page mutations.
 */
const SIDE_EFFECTFUL_GLOBAL_CALLS = [
    'cancelAnimationFrame',
    'cancelIdleCallback',
    'clearInterval',
    'clearTimeout',
    'eval',
    'Function',
    'queueMicrotask',
    'requestAnimationFrame',
    'requestIdleCallback',
    'setInterval',
    'setTimeout',
];

/**
 * Match a direct method reference whose name is known to mutate observable state.
 */
const MUTATING_METHOD_REFERENCE_PATTERN = new RegExp(
    `\\.\\s*(?:${MUTATING_METHOD_NAMES.join('|')})\\b`,
    'i',
);

/**
 * Match receiver-sensitive mutators whose method names also have read-only uses on other types.
 */
const RECEIVER_SENSITIVE_MUTATION_PATTERN =
    /(?:\.\s*classList\s*\.\s*(?:add|remove|replace|toggle)|\bObject\s*\.\s*assign)\b/i;

/**
 * Match a computed method reference such as `element['click']`.
 */
const COMPUTED_MUTATING_METHOD_REFERENCE_PATTERN = new RegExp(
    `\\[\\s*(['"])(?:${MUTATING_METHOD_NAMES.join('|')})\\1\\s*\\]`,
    'i',
);

/**
 * Match a global call that could perform a delayed or dynamically hidden mutation.
 */
const SIDE_EFFECTFUL_GLOBAL_CALL_PATTERN = new RegExp(
    `\\b(?:${SIDE_EFFECTFUL_GLOBAL_CALLS.join('|')})\\s*\\(`,
    'i',
);

/**
 * Determine whether a slash begins a regular-expression literal for the limited safety lexer.
 *
 * @param expression - Full JavaScript expression.
 * @param slashIndex - Index of the candidate slash.
 * @returns Whether the slash can begin a regular-expression literal.
 */
function isRegexLiteralStart(expression: string, slashIndex: number): boolean {
    let previousIndex = slashIndex - 1;
    while (previousIndex >= 0 && /\s/.test(expression[previousIndex] ?? '')) {
        previousIndex -= 1;
    }
    if (previousIndex < 0) {
        return true;
    }

    const previous = expression[previousIndex] ?? '';
    if ('([{=,:;!?&|+-*%^~<>'.includes(previous)) {
        return true;
    }

    const prefix = expression.slice(0, previousIndex + 1);
    return /\b(?:return|case|throw|typeof|instanceof|in|of|delete|void|new|yield|await)\s*$/.test(
        prefix,
    );
}

/**
 * Replace string, comment, and regular-expression contents with spaces while preserving indexes.
 *
 * Template literals are rejected separately because interpolations can contain arbitrary code. This
 * small lexer is intentionally conservative and is used only before explicit side-effect checks; it
 * never executes or rewrites the model expression.
 *
 * @param expression - JavaScript expression to mask.
 * @returns Same-length string containing only executable code characters.
 */
function maskNonCodeCharacters(expression: string): string {
    const masked = [...expression];
    let index = 0;

    while (index < expression.length) {
        const character = expression[index] ?? '';
        const next = expression[index + 1] ?? '';

        if (character === "'" || character === '"') {
            const quote = character;
            masked[index] = ' ';
            index += 1;
            while (index < expression.length) {
                const current = expression[index] ?? '';
                masked[index] = ' ';
                if (current === '\\') {
                    index += 1;
                    if (index < expression.length) {
                        masked[index] = ' ';
                    }
                } else if (current === quote) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            continue;
        }

        if (character === '/' && next === '/') {
            masked[index] = ' ';
            masked[index + 1] = ' ';
            index += 2;
            while (index < expression.length && expression[index] !== '\n') {
                masked[index] = ' ';
                index += 1;
            }
            continue;
        }

        if (character === '/' && next === '*') {
            masked[index] = ' ';
            masked[index + 1] = ' ';
            index += 2;
            while (index < expression.length) {
                const current = expression[index] ?? '';
                const following = expression[index + 1] ?? '';
                masked[index] = ' ';
                if (current === '*' && following === '/') {
                    masked[index + 1] = ' ';
                    index += 2;
                    break;
                }
                index += 1;
            }
            continue;
        }

        if (character === '/' && next !== '=' && isRegexLiteralStart(expression, index)) {
            masked[index] = ' ';
            index += 1;
            let inCharacterClass = false;
            while (index < expression.length) {
                const current = expression[index] ?? '';
                masked[index] = ' ';
                if (current === '\\') {
                    index += 1;
                    if (index < expression.length) {
                        masked[index] = ' ';
                    }
                } else if (current === '[') {
                    inCharacterClass = true;
                } else if (current === ']') {
                    inCharacterClass = false;
                } else if (current === '/' && !inCharacterClass) {
                    index += 1;
                    while (index < expression.length && /[a-z]/i.test(expression[index] ?? '')) {
                        masked[index] = ' ';
                        index += 1;
                    }
                    break;
                }
                index += 1;
            }
            continue;
        }

        index += 1;
    }

    return masked.join('');
}

/**
 * Determine whether an equals sign initializes a simple local variable declaration.
 *
 * Local declaration initializers are allowed because they do not alter page state. Later writes to
 * the same variable still fail the general assignment check.
 *
 * @param executableCode - Literal-masked JavaScript expression.
 * @param equalsIndex - Index of the equals sign being inspected.
 * @returns Whether this equals sign is a simple `const`, `let`, or `var` initializer.
 */
function isSimpleVariableInitializer(executableCode: string, equalsIndex: number): boolean {
    return /\b(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*$/.test(executableCode.slice(0, equalsIndex));
}

/**
 * Find an assignment operator that can mutate page or externally reachable state.
 *
 * @param executableCode - Literal-masked JavaScript expression.
 * @returns Whether a forbidden assignment operator is present.
 */
function containsForbiddenAssignment(executableCode: string): boolean {
    for (let index = 0; index < executableCode.length; index += 1) {
        if (executableCode[index] !== '=') {
            continue;
        }

        const previous = executableCode[index - 1] ?? '';
        const next = executableCode[index + 1] ?? '';
        if (next === '=' || next === '>' || '=!<>'.includes(previous)) {
            continue;
        }
        if (isSimpleVariableInitializer(executableCode, index)) {
            continue;
        }
        return true;
    }
    return false;
}

/**
 * Validate an evaluate_js expression against the safety blocklist and length cap.
 *
 * @param expr - The JavaScript expression string from the LLM.
 * @param maxLen - The maximum allowed length in characters.
 * @returns `null` if valid, otherwise an error message string.
 */
export function validateExpression(expr: string, maxLen: number): string | null {
    if (expr.length > maxLen) {
        return `expression exceeds maximum length of ${maxLen} characters`;
    }
    const lower = expr.toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
        if (lower.includes(pattern.toLowerCase())) {
            return `expression rejected by safety validator: contains blocked pattern "${pattern}"`;
        }
    }

    if (expr.includes('`')) {
        return 'expression rejected by read-only validator: template literals are not allowed';
    }

    const executableCode = maskNonCodeCharacters(expr);
    if (containsForbiddenAssignment(executableCode)) {
        return 'expression rejected by read-only validator: assignment is not allowed';
    }
    if (/(?:\+\+|--)/.test(executableCode)) {
        return 'expression rejected by read-only validator: update operators are not allowed';
    }
    if (/\bdelete\b/.test(executableCode)) {
        return 'expression rejected by read-only validator: delete is not allowed';
    }
    if (
        MUTATING_METHOD_REFERENCE_PATTERN.test(executableCode) ||
        RECEIVER_SENSITIVE_MUTATION_PATTERN.test(executableCode) ||
        COMPUTED_MUTATING_METHOD_REFERENCE_PATTERN.test(expr)
    ) {
        return 'expression rejected by read-only validator: mutating method access is not allowed';
    }
    if (SIDE_EFFECTFUL_GLOBAL_CALL_PATTERN.test(executableCode)) {
        return 'expression rejected by read-only validator: deferred or dynamic code is not allowed';
    }
    return null;
}

/**
 * Return a JSON-safe description of a large arbitrary read-only evaluation result.
 *
 * @param value - Browser evaluation result that is too large to inline.
 * @returns Compact structural preview without recursively copying the full result.
 */
export function describeLargeEvaluationResult(value: unknown): Record<string, unknown> {
    if (Array.isArray(value)) {
        return {
            kind: 'array',
            itemCount: value.length,
            itemTypes: [...new Set(value.slice(0, 20).map((item) => typeof item))],
        };
    }
    if (value !== null && typeof value === 'object') {
        return {
            kind: 'object',
            keys: Object.keys(value as Record<string, unknown>).slice(0, 20),
        };
    }
    if (typeof value === 'string') {
        return {
            kind: 'string',
            characterCount: value.length,
            preview: value.slice(0, 512),
        };
    }
    return { kind: value === null ? 'null' : typeof value };
}

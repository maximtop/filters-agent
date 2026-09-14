import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Logger } from '../logger/logger';
import { TurnStopReason } from './stop-reason';

/**
 * The one gap this seam closes in pi's in-run retry classification: a Cloudflare origin status that
 * pi does not know is transient, and therefore never retries.
 *
 * The gateway this runtime talks to sits behind Cloudflare, and Cloudflare answers an origin-side
 * fault with its own 52x/530 range rather than the origin's status. Pi classifies a failed turn
 * from the composed error MESSAGE against a fixed list of substrings, so a status it did not
 * enumerate is simply not transient to it — and none of the `retry` settings pi exposes (`enabled`,
 * `maxRetries`, `baseDelayMs`, `provider.timeoutMs`) carries a predicate, a pattern, or a status
 * list. There is no supported hook; extending the decision means reaching into the session object
 * pi hands back.
 *
 * `extendTransientGatewayRetry` is that reach, kept to one wrapped method in one module so the
 * whole vendor coupling is visible in one place when the pin moves.
 */

/**
 * Leading HTTP status of a Cloudflare origin-side failure, as pi-ai composes a provider error for
 * the `openai-completions` API this runtime registers.
 *
 * Why this set — 520 through 527, plus 530: pi-ai's own `RETRYABLE_PROVIDER_ERROR_PATTERN`
 * (`dist/utils/retry.js` of the pinned 0.84.1) enumerates transient HTTP statuses one literal at a
 * time — `429`, `500`, `502`, `503`, `504`, `524` — and stops there. Cloudflare's origin-side range
 * is 520-527 and 530, of which only 524 (a gateway timeout) made pi's list. A live campaign run was
 * answered `520 status code (no body)` on one loop request; pi read the message, found nothing it
 * recognized, ended the turn in error, and the run sealed `provider-failure` after that single
 * attempt — one whole case spent on one edge hiccup that the deleted status-based loop retried as
 * an ordinary 5xx. 524 is kept in the range deliberately: the set means "Cloudflare answered for
 * the origin", and pi already retrying one member of it is not a reason to spell the range with a
 * hole.
 *
 * Why anchored at the start: that is where the status lands. For this API pi-ai's
 * `formatProviderError` composes `"<status>: <body>"` with NO provider prefix (the same structural
 * fact `isDeterministicProviderMessage` reads in `run-sealing.ts`), and when the response carries
 * no body at all the OpenAI SDK's own message is `"<status> status code (no body)"` — the exact
 * text the campaign saw. Anchoring is what keeps a token count, an id or a byte size quoted inside
 * a body from being read as a gateway status.
 */
const TRANSIENT_GATEWAY_STATUS_PATTERN = /^\s*(?:52[0-7]|530)\b/u;

/**
 * The pinned-vendor slice of pi's `AgentSession` this seam replaces.
 *
 * `_isRetryableError` is `private` in pi's `.d.ts`, so it is reachable only through a cast; naming
 * the one member here — instead of casting to `any` or to the whole session — keeps the wrapper
 * type-checked against the exact signature pi calls (`dist/core/agent-session.js`, from
 * `_willRetryAfterAgentEnd` and `_handlePostAgentRun`) and makes a signature change at the next
 * version bump a compile error rather than a silent no-op.
 */
interface RetryDecidingSession {
    /**
     * Pi's own decision on whether a failed turn's assistant message may be retried.
     */
    _isRetryableError(message: AssistantMessage): boolean;
}

/**
 * Decide whether a failed turn is a transient Cloudflare gateway failure pi does not recognize.
 *
 * Deliberately narrow: only a turn that actually ended in a provider error with a message, only a
 * message whose LEADING status is in the Cloudflare origin range, and never a context overflow —
 * pi's rule that an overflow is handled by compaction rather than by retry is the one part of its
 * decision this seam must not override, so it is re-asserted here instead of being assumed
 * unreachable. `isContextOverflow` is called without a context window on purpose: its two
 * window-dependent cases (a silently accepted overflow, a zero-output `length` stop) require a
 * non-error stop reason, which the first guard has already excluded.
 *
 * @param message - The failed turn's assistant message, as pi hands it to its own predicate.
 * @returns True when the turn should be retried despite pi classifying it as terminal.
 */
function isTransientGatewayFailure(message: AssistantMessage): boolean {
    if (message.stopReason !== TurnStopReason.Error) {
        return false;
    }
    const errorMessage = message.errorMessage;
    if (errorMessage === undefined || errorMessage === '') {
        return false;
    }
    if (isContextOverflow(message)) {
        return false;
    }
    return TRANSIENT_GATEWAY_STATUS_PATTERN.test(errorMessage);
}

/**
 * Extend one built session's retry decision with the transient gateway statuses pi does not know.
 *
 * This is a pinned-vendor seam against `@earendil-works/pi-coding-agent@0.84.1`: pi's retry
 * settings expose no predicate or pattern hook (see the module note), so the created session's own
 * `_isRetryableError` is wrapped — pi's answer OR ours, never instead of pi's. Both of pi's call
 * sites read the method off `this`, so an own property on the instance is enough and nothing else
 * about the session changes; the configured `maxRetries` still bounds how many times the extended
 * decision can fire, so a gateway that is down rather than blipping still seals `provider-failure`,
 * just after the retries the run paid for.
 *
 * @param session - The session `createAgentSession` returned.
 * @param logger - Application logger; every extension of pi's decision is logged, because a retry
 *   that pi itself would not have made must be visible in the run that made it. Pi consults the
 *   decision from both of its call sites for one failed turn, so the line can appear twice per turn
 *   — it records a classification, not an attempt, and the turn's own `provider turn failed` line
 *   beside it is the attempt.
 */
export function extendTransientGatewayRetry(session: AgentSession, logger: Logger): void {
    const vendor = session as unknown as RetryDecidingSession;
    // The leading underscore is pi's own spelling of the member, not a convention this codebase
    // adopts: the whole point of the seam is to replace THAT method, so the name cannot be chosen.
    /* oxlint-disable no-underscore-dangle */
    const piDecision = vendor._isRetryableError.bind(vendor);
    vendor._isRetryableError = (message: AssistantMessage): boolean => {
        if (piDecision(message)) {
            return true;
        }
        if (!isTransientGatewayFailure(message)) {
            return false;
        }
        logger.warn(
            { message: message.errorMessage },
            'classified a transient gateway failure retryable that pi would have failed fast on',
        );
        return true;
    };
    /* oxlint-enable no-underscore-dangle */
}

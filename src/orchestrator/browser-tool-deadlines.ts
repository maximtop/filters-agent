/**
 * The wall-clock bounds of the runtime's browser tools.
 *
 * They live apart from the registrations that apply them because they are read from three places —
 * the lifecycle registrations, the runtime's own per-tool wrapping, and the tests that advance
 * timers past them — and because each value is a recorded observation about production, not a
 * detail of how a tool is registered.
 */
import { APPLICATION_SESSION_BUDGET_MS } from '../validator/phase-application-contract';

/**
 * Hard deadline for one browser tool call.
 *
 * The loop's wall-clock budget is checked between turns, so it cannot end a turn that never
 * returns: one live run hung inside a browser launch and sat there for over two hours despite a
 * one-hour budget. This bounds the call itself, and the model is told the tool timed out so it can
 * choose a different move.
 */
export const BROWSER_TOOL_DEADLINE_MS = 3 * 60_000;

/**
 * Wall-clock room one launch's readiness waits need beside the application session.
 *
 * A launch runs a readiness pre-read before the session and a state read-back after it; at the
 * default configuration those waits bound themselves to 30 s and 90 s, and an aborted call gets up
 * to 90 s to record its own cleanup before the agent loop continues. Four minutes fits that sum
 * with bootstrap slack.
 */
const BROWSER_LAUNCH_READINESS_ENVELOPE_MS = 4 * 60_000;

/**
 * Hard deadline for one `launch_browser` call.
 *
 * A launch runs the readiness pre-read, the whole bounded application session
 * (`APPLICATION_SESSION_BUDGET_MS`), and the host read-back inside one tool call, so the plain
 * browser-tool deadline would end a valid launch while its session kept spending turns in the
 * background. This deadline covers the session budget plus the readiness envelope, and the handler
 * threads its abort signal into the session so a timed-out launch discards its late read-back.
 */
export const BROWSER_LAUNCH_DEADLINE_MS =
    APPLICATION_SESSION_BUDGET_MS + BROWSER_LAUNCH_READINESS_ENVELOPE_MS;

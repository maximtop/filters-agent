/**
 * Replay-mode pi session wiring: runs the pi session for one closed-issue replay — pi runtime, the
 * frozen replay tool set adapted from the legacy registry, the submit_replay_verdict terminal tool
 * carrying the ReplayVerdict schema, prompt documents, budgets — and seals the run trace from the
 * pi outcome. The legacy text-sealing protocol is gone from replay: a fenced-JSON grading block in
 * prose is never parsed, and a run that seals without an accepted verdict is reported as a typed
 * replay failure instead of being graded at all.
 */
import { ToolName } from '../agent/tool-names';
import type { ToolRegistry } from '../agent/tool-registry';
import type { AppConfig } from '../config/config';
import type { Logger } from '../logger/logger';
import { SealKind, type TerminalOutcome } from '../pi/seal-types';
import {
    buildModeTerminal,
    resolveSessionRuntime,
    runModeSession,
    type ModeSessionResult,
    type SharedModeSessionOptions,
} from '../session/mode-session';
import { buildRegistrySessionTools } from '../session/registry-session-tools';
import { sealDetail } from '../tracer/session-trace';
import { PromptDocumentName } from '../prompts/prompt-documents';
import { ReplayVerdictSchema } from '../types/replay';
import type { ReplayVerdict } from '../types/replay';
import type { ReplayAgentOutput } from './replay-grader';
import type { ReplayFailureReason } from './replay-failure';

/**
 * Turn cap, carried over from the legacy replay loop's maxIterations of 20.
 */
const REPLAY_MAX_TURNS = 20;

/**
 * What one replay session needs: configuration, issue identity, the run recorder, the mode's
 * registry, the artifact/work directory, and the caller-owned signal for cancellation.
 */
export interface ReplaySessionOptions extends SharedModeSessionOptions {
    /**
     * Validated application configuration (LLM provider, GitHub credentials, browser knobs).
     */
    config: AppConfig;

    /**
     * The closed issue number being replayed.
     */
    issueNumber: number;

    /**
     * The replay registry from createToolRegistry.
     */
    registry: ToolRegistry;

    /**
     * Directory the session is logically rooted at (the replay artifacts directory; also the pi
     * session workDir).
     */
    artifactsDir: string;

    /**
     * Application logger for run and grading diagnostics.
     */
    logger: Logger;
}

/**
 * Result of one replay session: the sealed pi outcome and the run trace it sealed.
 */
export type ReplaySessionRun = ModeSessionResult<ReplayVerdict>;

/**
 * Run one replay session on pi and seal its trace.
 *
 * @param options - The session options.
 * @returns The sealed outcome and trace.
 */
export async function runReplaySession(options: ReplaySessionOptions): Promise<ReplaySessionRun> {
    const { config, issueNumber, recorder, registry } = options;
    return await runModeSession<ReplayVerdict>({
        runtime: await resolveSessionRuntime(options, config.llm),
        llm: config.llm,
        recorder,
        terminalToolName: ToolName.SubmitReplayVerdict,
        renderTask: (prompts, terminalToolName) =>
            prompts.render(PromptDocumentName.ReplayTask, {
                issueNumber: String(issueNumber),
                terminalToolName,
            }),
        terminal: buildModeTerminal(ToolName.SubmitReplayVerdict, ReplayVerdictSchema, recorder),
        // The shared quartet stubs are appended inside buildRegistrySessionTools (defaults).
        tools: buildRegistrySessionTools(registry, recorder),
        maxTurns: REPLAY_MAX_TURNS,
        workDir: options.artifactsDir,
        logger: options.logger,
        signal: options.signal,
        usageCollector: options.usageCollector,
    });
}

/**
 * Whether a sealed replay run produced something the grader may score.
 */
export const ReplayGradingStatus = {
    /**
     * The agent submitted a verdict through the terminal tool: the run is a measurement.
     */
    Gradeable: 'gradeable',

    /**
     * The run sealed on an infrastructure ending, so there is no agent answer to score.
     */
    NotGradeable: 'not-gradeable',
} as const;

/**
 * Every ReplayGradingStatus value, for schemas and exhaustive listings.
 */
export const REPLAY_GRADING_STATUS_VALUES = Object.values(ReplayGradingStatus);

/**
 * ReplayGradingStatus value.
 */
export type ReplayGradingStatus = (typeof ReplayGradingStatus)[keyof typeof ReplayGradingStatus];

/**
 * A replay run that reached an accepted terminal verdict.
 */
export interface GradeableReplayRun {
    /**
     * Discriminator: the run may be graded.
     */
    status: typeof ReplayGradingStatus.Gradeable;

    /**
     * The agent's submitted verdict, projected onto the grader's input shape.
     */
    output: ReplayAgentOutput;
}

/**
 * A replay run that sealed without an accepted terminal verdict.
 */
export interface NotGradeableReplayRun {
    /**
     * Discriminator: the run must never be graded.
     */
    status: typeof ReplayGradingStatus.NotGradeable;

    /**
     * The seal kind the run ended on.
     */
    reason: ReplayFailureReason;

    /**
     * The seal's human-readable detail (provider message, no-terminal diagnosis, rejection reason,
     * tripped budget, or abort context).
     */
    detail: string;
}

/**
 * What the grading path receives for one sealed replay run.
 */
export type ReplayGradingInput = GradeableReplayRun | NotGradeableReplayRun;

/**
 * Map the sealed replay outcome onto the grading input: an accepted verdict 1:1 (placement omitted
 * when the agent gave none), every other seal as a not-gradeable run carrying the typed seal reason
 * and detail.
 *
 * Only an accepted verdict may be graded. A provider failure, an exhausted budget, a caller abort,
 * a rejected terminal payload, or a run that never called the terminal tool is an infrastructure
 * ending; scoring it as an ordinary `cannot-reproduce` verdict — which is what the legacy parse
 * fallback produced — would silently credit outages to the agent's agreement rate.
 *
 * @param outcome - The sealed pi outcome.
 * @param logger - Application logger for the non-terminal warn.
 * @returns The gradeable agent output, or the typed not-gradeable ending.
 */
export function replayOutcomeToGradingInput(
    outcome: TerminalOutcome<ReplayVerdict>,
    logger: Logger,
): ReplayGradingInput {
    if (outcome.kind === SealKind.Terminal) {
        return {
            status: ReplayGradingStatus.Gradeable,
            output: {
                agentOutcome: outcome.payload.outcome,
                agentRules: outcome.payload.rules,
                ...(outcome.payload.placement === undefined
                    ? {}
                    : { agentPlacement: outcome.payload.placement }),
            },
        };
    }
    const detail = sealDetail(outcome);
    logger.warn(
        { outcome: outcome.kind, detail },
        'replay run sealed without a replay verdict — the run is not gradeable',
    );
    return { status: ReplayGradingStatus.NotGradeable, reason: outcome.kind, detail };
}

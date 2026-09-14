/**
 * The launch procedure the prompt-driven session modes share — analyze, replay, the
 * pre-orchestrated fix path and the agentic fix session. Each mode owns what genuinely differs (its
 * task document and fills, its terminal payload schema, its tool surface, its bounds, and what it
 * makes of the sealed outcome); everything between those choices is one procedure written once
 * here: render the three prompt documents from one loader, map the configured provider bounds onto
 * the pi runner, record every turn, every refused tool call and every context compaction into the
 * run trace, and attach the run's usage summary.
 *
 * The procedure is split in two so the fix path can share it without turning it into an options
 * bag: `launchModeSession` runs the session and hands back the sealed outcome plus the run's
 * compaction count, and `runModeSession` adds the one seal every mode but fix wants. The agentic
 * fix session calls the launch and maps the seal onto its own legacy-shaped result.
 */
import type * as v from 'valibot';
import { TOOL_GUIDANCE } from '../agent/tool-catalog';
import type { ToolName } from '../agent/tool-names';
import type { LlmConfig } from '../config/config';
import type { Logger } from '../logger/logger';
import { createPiRuntimeFromConfig, providerMaxRetries } from '../pi/llm-wiring';
import type { PiRuntime } from '../pi/runtime';
import { runAgentSession } from '../pi/session-runner';
import { buildTerminalTool, type TerminalToolController } from '../pi/terminal-tool';
import type { TerminalOutcome } from '../pi/seal-types';
import type { TurnObserver } from '../pi/session-observations';
import type { SessionToolSpec } from '../pi/session-tool-types';
import type { RunUsageCollector } from '../pi/usage-collector';
import {
    createPromptDocumentLoader,
    PromptDocumentName,
    type PromptDocumentLoader,
} from '../prompts/prompt-documents';
import {
    recordSessionCompaction,
    recordSessionTurn,
    recordTerminalTool,
    recordToolBounce,
    sealSessionTrace,
} from '../tracer/session-trace';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { RunTrace } from '../types/trace';

/**
 * The three rendered documents one mode session runs on.
 */
export interface SessionPrompts {
    /**
     * The shared system document, identical for every mode.
     */
    systemPrompt: string;

    /**
     * The mode's rendered task document.
     */
    userTask: string;

    /**
     * The re-prompt sent once when a turn ends without the terminal call.
     */
    nudge: string;
}

/**
 * Renders one mode's task document. The terminal tool name arrives as an argument rather than being
 * restated by the mode, so a task fill can never name a different tool than the session
 * advertises.
 */
export type TaskRenderer = (prompts: PromptDocumentLoader, terminalToolName: ToolName) => string;

/**
 * Render the prompt trio of one mode session from a single loader.
 *
 * The terminal tool name is spelled once and filled into both the task document and the nudge, so
 * the two can never name different tools to the model.
 *
 * @param terminalToolName - The mode's terminal tool name.
 * @param renderTask - Renders the mode's own task document from the session's loader.
 * @returns The three rendered documents.
 */
export function renderSessionPrompts(
    terminalToolName: ToolName,
    renderTask: TaskRenderer,
): SessionPrompts {
    const prompts = createPromptDocumentLoader();
    return {
        systemPrompt: prompts.render(PromptDocumentName.System),
        userTask: renderTask(prompts, terminalToolName),
        nudge: prompts.render(PromptDocumentName.Nudge, { terminalToolName }),
    };
}

/**
 * The options every mode session that accepts an injected runtime declares, so the six fields and
 * their contracts are written once instead of restated per mode.
 */
export interface SharedModeSessionOptions {
    /**
     * Reasoning-model override; defaults to `config.llm.model`.
     */
    model?: string;

    /**
     * The run's trace recorder.
     */
    recorder: TraceRecorder;

    /**
     * Application logger, forwarded into the session so a `--verbose` run keeps one logger — and
     * one level — for the whole run instead of letting the runner build a second one at info.
     */
    logger?: Logger;

    /**
     * The run's already-created pi runtime — the same instance the vision client binds; when absent
     * the session creates its own.
     */
    runtime?: PiRuntime;

    /**
     * Caller cancellation; aborted runs seal as `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Optional run-scoped usage collector threaded from the caller (mirroring `runtime`): session
     * usage lands in it and the sealed trace carries the rendered summary block.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Resolve the pi runtime one mode session runs on: the caller's injected instance, or a fresh one
 * built from the configured provider slice.
 *
 * @param options - The mode's shared options (the injection seam and the model override).
 * @param llm - The validated LLM provider configuration.
 * @returns The runtime the session runs on.
 */
export async function resolveSessionRuntime(
    options: SharedModeSessionOptions,
    llm: LlmConfig,
): Promise<PiRuntime> {
    return options.runtime ?? (await createPiRuntimeFromConfig(llm, options.model));
}

/**
 * Build one mode's terminal tool from the catalog: the name is a declared {@link ToolName}, the
 * model-facing text is that name's single `TOOL_GUIDANCE` entry, and every submission — accepted or
 * rejected — lands in the run trace.
 *
 * @param name - The mode's terminal tool name.
 * @param schema - The mode's terminal payload schema.
 * @param recorder - The run trace recorder.
 * @returns The recording terminal controller.
 */
export function buildModeTerminal<T>(
    name: ToolName,
    schema: v.GenericSchema<T>,
    recorder: TraceRecorder,
): TerminalToolController<T> {
    return recordTerminalTool(
        buildTerminalTool<T>({ name, description: TOOL_GUIDANCE[name]!, schema }),
        recorder,
    );
}

/**
 * What one mode session launch needs beyond the mode's own tools, terminal and task document.
 */
export interface ModeSessionRequest<T> {
    /**
     * The run's pi runtime handle.
     */
    runtime: PiRuntime;

    /**
     * The validated LLM provider configuration the request bounds and retries are mapped from.
     */
    llm: LlmConfig;

    /**
     * The run trace recorder: every turn, the usage summary and the seal land in it.
     */
    recorder: TraceRecorder;

    /**
     * The mode's terminal tool name, filled into the task document and the nudge.
     */
    terminalToolName: ToolName;

    /**
     * Renders the mode's task document from the session's prompt loader.
     */
    renderTask: TaskRenderer;

    /**
     * The mode's terminal tool controller, already wrapped for trace recording.
     */
    terminal: TerminalToolController<T>;

    /**
     * The mode's non-terminal tool surface, already wrapped for trace recording.
     */
    tools: SessionToolSpec[];

    /**
     * The mode's turn cap.
     */
    maxTurns: number;

    /**
     * Wall-clock investigation budget; unset leaves the run bounded by turns alone, which is what
     * every mode but the agentic fix path wants.
     */
    wallClockMs?: number;

    /**
     * Directory the session is logically rooted at (also pi's work directory).
     */
    workDir: string;

    /**
     * Application logger, forwarded into the session so a `--verbose` run keeps one logger — and
     * one level — for the whole run instead of letting the runner build a second one at info.
     */
    logger?: Logger;

    /**
     * Caller cancellation; aborted runs seal as `aborted`.
     */
    signal?: AbortSignal;

    /**
     * Optional run-scoped usage collector; when present the session's usage lands in it and the
     * sealed trace carries the rendered summary block.
     */
    usageCollector?: RunUsageCollector;

    /**
     * Extra per-turn sink, invoked after the trace recording of the same turn. The agentic fix run
     * feeds its delivered-frontier observation sink from here.
     */
    onTurnEnd?: TurnObserver;
}

/**
 * What one launched mode session hands back before any seal is written.
 */
export interface ModeSessionLaunch<T> {
    /**
     * The sealed pi outcome (typed terminal payload or a failure seal).
     */
    outcome: TerminalOutcome<T>;

    /**
     * How many times pi compacted this run's context, for the seal that marks the run with it.
     */
    compactions: number;
}

/**
 * What one mode session returns: the sealed pi outcome and the trace it sealed. Modes that continue
 * with a fallback payload derive it from the outcome themselves.
 */
export interface ModeSessionResult<T> {
    /**
     * The sealed outcome (typed terminal payload or a failure seal).
     */
    outcome: TerminalOutcome<T>;

    /**
     * The run trace, sealed (run_end event written).
     */
    trace: RunTrace;
}

/**
 * Run one mode session on pi and attach the run's usage summary, leaving the trace unsealed.
 *
 * @param request - The launch request.
 * @returns The sealed pi outcome and the run's compaction count.
 */
export async function launchModeSession<T>(
    request: ModeSessionRequest<T>,
): Promise<ModeSessionLaunch<T>> {
    const { recorder, usageCollector } = request;
    const compaction = recordSessionCompaction(recorder);
    const recordTurn = recordSessionTurn(recorder);
    const extraTurnSink = request.onTurnEnd;
    const { systemPrompt, userTask, nudge } = renderSessionPrompts(
        request.terminalToolName,
        request.renderTask,
    );
    const outcome = await runAgentSession<T>({
        runtime: request.runtime,
        systemPrompt,
        userTask,
        nudge,
        terminal: request.terminal,
        tools: request.tools,
        budgets: {
            maxTurns: request.maxTurns,
            wallClockMs: request.wallClockMs,
            requestTimeoutMs: request.llm.requestTimeoutMs,
        },
        retries: { maxRetries: providerMaxRetries(request.llm) },
        reasoningEffort: request.llm.reasoningEffort,
        signal: request.signal,
        workDir: request.workDir,
        logger: request.logger,
        onTurnEnd:
            extraTurnSink === undefined
                ? recordTurn
                : (turn) => {
                      recordTurn(turn);
                      extraTurnSink(turn);
                  },
        onCompaction: compaction.observe,
        // Every mode records them: a call pi refused before `execute` reaches no tool wrapper, so
        // without this the submission and pi's reason are absent from the run evidence entirely.
        onToolBounce: recordToolBounce(recorder),
        onSessionUsage: (report) => usageCollector?.addSession(report),
    });
    if (usageCollector) {
        recorder.setUsageSummary(usageCollector.summary());
    }
    return { outcome, compactions: compaction.count() };
}

/**
 * Run one mode session on pi and seal its trace.
 *
 * @param request - The launch request.
 * @returns The sealed outcome and the sealed run trace.
 */
export async function runModeSession<T>(
    request: ModeSessionRequest<T>,
): Promise<ModeSessionResult<T>> {
    const { outcome, compactions } = await launchModeSession<T>(request);
    return { outcome, trace: sealSessionTrace(request.recorder, outcome, compactions) };
}

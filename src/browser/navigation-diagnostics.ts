import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { IBrowserSession } from './browser-interfaces';
import { redactNetworkLog } from './har-redactor';
import type { BrowserFallbackReason } from '../types/fix-run-result';

/**
 * Hard time box for one best-effort diagnostics step against a possibly wedged page.
 */
const DIAGNOSTICS_STEP_TIMEOUT_MS = 2_000;

/**
 * Number of tail entries retained from the accumulated network and console logs.
 */
const DIAGNOSTICS_LOG_TAIL_LENGTH = 50;

/**
 * Facts and session handles needed to capture one navigation-failure diagnostics bundle.
 */
export interface NavigationFailureDiagnosticsInput {
    /**
     * Session whose page, network log, and console log are snapshotted.
     */
    session: IBrowserSession;

    /**
     * Prompt-safe target URL the failed open_page call tried to reach.
     */
    targetUrl: string;

    /**
     * Main-frame URL chain observed between goto and the failure.
     */
    frameNavigations: readonly string[];

    /**
     * Bounded failure text already prepared for the model-facing result.
     */
    error: string;

    /**
     * Typed navigation failure category returned to the model.
     */
    fallbackReason: BrowserFallbackReason;

    /**
     * Host-side diagnostics root; file writes are skipped when unset.
     */
    diagnosticsDir?: string;

    /**
     * Operational logger mirroring the failure facts into the job log.
     */
    logger?: Logger;
}

/**
 * Resolve one best-effort diagnostics step, or undefined when it overruns its time box.
 *
 * @param step - Diagnostics step against the live page.
 * @returns Step result, or undefined on timeout.
 */
async function withStepTimeout<T>(step: Promise<T>): Promise<T | undefined> {
    return await Promise.race([
        step,
        new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), DIAGNOSTICS_STEP_TIMEOUT_MS);
        }),
    ]);
}

/**
 * Capture host-side diagnostics for one failed open_page call.
 *
 * Everything here is best-effort: diagnostics must never change the tool contract, so every step is
 * individually time-boxed and every failure is swallowed. Files land in the human diagnostics
 * directory that ships with the run evidence bundle; nothing enters the prompt-safe model bundle.
 *
 * @param input - Failure facts and the session to snapshot.
 */
export async function captureNavigationFailureDiagnostics(
    input: NavigationFailureDiagnosticsInput,
): Promise<void> {
    const { session, targetUrl, frameNavigations, error, fallbackReason, diagnosticsDir, logger } =
        input;
    logger?.warn(
        {
            targetUrl,
            fallbackReason,
            frameNavigations,
            error: error.slice(0, 500),
        },
        'open_page navigation failed',
    );
    if (!diagnosticsDir) {
        return;
    }
    try {
        const page = session.getPage();
        let finalUrl: string | undefined;
        try {
            finalUrl = page.url();
        } catch {
            finalUrl = undefined;
        }
        const title = await withStepTimeout(page.title()).catch(() => undefined);
        const screenshot = await withStepTimeout(page.screenshot({ type: 'png' })).catch(
            () => undefined,
        );
        const networkTail = redactNetworkLog(
            session.getNetworkLog().slice(-DIAGNOSTICS_LOG_TAIL_LENGTH),
        );
        const consoleTail = session.getConsoleLog().slice(-DIAGNOSTICS_LOG_TAIL_LENGTH);

        const bundleDir = join(
            diagnosticsDir,
            'navigation-failures',
            `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`,
        );
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(
            join(bundleDir, 'diagnostics.json'),
            JSON.stringify(
                {
                    targetUrl,
                    fallbackReason,
                    error: error.slice(0, 1_000),
                    finalUrl: finalUrl ?? null,
                    title: title ?? null,
                    frameNavigations: [...frameNavigations],
                    networkTail,
                    consoleTail,
                },
                null,
                2,
            ),
        );
        if (screenshot) {
            writeFileSync(join(bundleDir, 'screenshot.png'), screenshot);
        }
    } catch (captureError) {
        logger?.warn(
            { err: captureError, targetUrl },
            'navigation failure diagnostics capture failed',
        );
    }
}

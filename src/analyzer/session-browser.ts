/**
 * Shared optional browser bootstrap for registry-driven session modes (analyze, replay): repro
 * profile from the issue, BrowserSession over the cloak engine, the pi-bound single-shot vision
 * client, browser tool handlers, and the site analyzer. Without a configured cloakBrowserPath, or
 * when the launch fails with BrowserLaunchError, the mode continues reasoning-only with no browser
 * tools.
 */
import type { BrowserSession } from '../browser/browser-session';
import { BrowserLaunchError } from '../browser/browser-session';
import type { BrowserToolOptions } from '../agent/browser-tool-bindings';
import type { AppConfig } from '../config/config';
import type { Logger } from '../logger/logger';
import { createVisionClient } from '../pi/llm-wiring';
import type { PiRuntime } from '../pi/runtime';
import type { RunUsageCollector } from '../pi/usage-collector';
import type { TraceRecorder } from '../tracer/trace-recorder';
import type { IssueFacts } from '../types/issue-facts';

/**
 * What one browser bootstrap needs: configuration, the extracted issue facts, the run pi runtime,
 * the run recorder, the artifact directory for browser evidence, and the logger.
 */
export interface SessionBrowserBootstrapOptions {
    /**
     * Validated application configuration (LLM provider, GitHub credentials, browser knobs).
     */
    config: AppConfig;

    /**
     * The extracted issue facts the repro profile and the browser origin are derived from.
     */
    facts: IssueFacts;

    /**
     * The run's pi runtime; the browser tools' single-shot client is bound to its vision handle —
     * the same runtime the agent session runs on.
     */
    runtime: PiRuntime;

    /**
     * Directory the browser artifacts are written to.
     */
    artifactsDir: string;

    /**
     * The run's trace recorder.
     */
    recorder: TraceRecorder;

    /**
     * Application logger for bootstrap diagnostics.
     */
    logger: Logger;

    /**
     * When present, the bootstrap vision client is metered into the run's usage collector — the
     * single-shot calls of the browser tools then land in the same summary as the loop session.
     */
    usageCollector?: RunUsageCollector;
}

/**
 * Result of one browser bootstrap: the session and its tool options when live evidence is possible,
 * otherwise neither (reasoning-only run).
 */
export interface SessionBrowserBootstrap {
    /**
     * The live browser session, when one was created.
     */
    browserSession?: BrowserSession;

    /**
     * Browser tool options for createToolRegistry, when a session was created.
     */
    browserTools?: BrowserToolOptions;
}

/**
 * Bootstrap the optional browser session for a registry-driven mode: derive the repro profile from
 * the extracted issue facts, launch the cloak engine session, build the browser tool handlers and
 * the site analyzer. A run without cloakBrowserPath, or with a BrowserLaunchError, continues
 * reasoning-only with no browser tools.
 *
 * @param options - Configuration, issue facts, recorder, artifact directory, and logger.
 * @returns The browser session and tool options, or an empty bootstrap.
 */
export async function bootstrapSessionBrowser(
    options: SessionBrowserBootstrapOptions,
): Promise<SessionBrowserBootstrap> {
    const { config, facts, artifactsDir, recorder, logger, runtime } = options;
    if (!config.cloakBrowserPath) {
        return {};
    }
    try {
        const { BrowserSession } = await import('../browser/browser-session');
        const { CloakBrowserEngine } = await import('../browser/cloakbrowser-engine');
        const { SiteAnalyzer } = await import('./site-analyzer');
        const { deriveReproProfile } = await import('./repro-profile');

        const profile = deriveReproProfile(facts);
        const browserAllowedOrigin = facts.reportedSiteUrls[0] ?? '';

        const engine = new CloakBrowserEngine();
        const browserSession = await BrowserSession.create({
            engine,
            logger,
            reproProfile: profile,
            artifactsDir,
            headless: config.headless,
            noSandbox: config.noSandbox,
        });

        const vision = createVisionClient(runtime, config.llm, {
            logger,
            usageCollector: options.usageCollector,
        });

        const { createBrowserToolHandlers } = await import('../browser/browser-tools');
        const handlers = createBrowserToolHandlers({
            session: browserSession,
            recorder,
            artifactsDir,
            allowedOrigin: browserAllowedOrigin,
            consentStrategy: profile.consentStrategy,
        });
        const siteAnalyzer = new SiteAnalyzer({ handlers, artifactsDir, recorder });
        const browserTools: BrowserToolOptions = {
            session: browserSession,
            analyzer: siteAnalyzer,
            artifactsDir,
            recorder,
            allowedOrigin: browserAllowedOrigin,
            vision,
        };
        logger.info(
            { browserType: engine.browserType, viewport: profile.viewport },
            'browser session ready for live analysis',
        );
        return { browserSession, browserTools };
    } catch (error) {
        if (error instanceof BrowserLaunchError) {
            logger.warn(
                { err: error.cause },
                'browser launch failed — falling back to reasoning-only analysis',
            );
            return {};
        }
        throw error;
    }
}

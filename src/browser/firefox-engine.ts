import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firefox } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import type {
    IBrowserEngine,
    BrowserEngineLaunchConfig,
    BrowserEnginePersistentLaunchConfig,
} from './browser-interfaces';
import { BrowserConfigurationError } from './browser-session';
import { FIREFOX_POLICIES_ENV_VAR } from './firefox-policies';

/**
 * Staged policies artifact the engine writes into the profile directory.
 */
const PROFILE_POLICIES_FILE_NAME = 'policies.json';

/**
 * Playwright Firefox engine reproducing the Firefox reporter environment.
 *
 * Extensions load only through enterprise policies: the engine stages a `policies.json` into the
 * profile directory and points the patched browser build at it through
 * `PLAYWRIGHT_FIREFOX_POLICIES_JSON` so a signed XPI is force-installed before the first page
 * loads. Unpacked Chromium extension directories have no Firefox equivalent and are rejected loudly
 * instead of being dropped.
 */
export class FirefoxEngine implements IBrowserEngine {
    /**
     * Engine identifier for logging and diagnostics.
     */
    readonly browserType = 'firefox';

    /**
     * Launch a plain Firefox instance through playwright-core.
     *
     * Locale and timezone are context-level options; a plain browser launch cannot carry them.
     *
     * @param config - Launch parameters forwarded to playwright-core's `firefox.launch()`.
     * @returns A Playwright-compatible Browser instance.
     */
    async launch(config: BrowserEngineLaunchConfig): Promise<Browser> {
        return await firefox.launch({
            headless: config.headless,
            args: config.args,
            env: config.environment,
            ...(config.browserProcessLogger ? { logger: config.browserProcessLogger } : {}),
            ...(config.ignoreDefaultArgs
                ? { ignoreDefaultArgs: [...config.ignoreDefaultArgs] }
                : {}),
        });
    }

    /**
     * Launch a persistent Firefox context with enterprise policies force-installing extensions.
     *
     * The policies file is staged into `<userDataDir>/policies.json` and the launch environment
     * gains the absolute path, so the browser applies the policies before its first session.
     *
     * @param config - Persistent profile and policy launch parameters.
     * @returns A Playwright-compatible persistent BrowserContext.
     */
    async launchPersistentContext(
        config: BrowserEnginePersistentLaunchConfig,
    ): Promise<BrowserContext> {
        if (config.extensionPaths.length > 0) {
            throw new BrowserConfigurationError(
                `${this.browserType} cannot load unpacked extension directories; ` +
                    'load a signed XPI through `firefoxPolicies` instead.',
            );
        }
        const policies: BrowserEnginePersistentLaunchConfig['firefoxPolicies'] =
            config.firefoxPolicies;
        const policiesPath = policies
            ? this.stagePolicies(config.userDataDir, policies)
            : undefined;
        return await firefox.launchPersistentContext(config.userDataDir, {
            headless: config.headless,
            locale: config.locale,
            timezoneId: config.timezone,
            userAgent: config.userAgent,
            viewport: config.viewport,
            env: this.launchEnvironment(config.environment, policiesPath),
            ...(config.browserProcessLogger ? { logger: config.browserProcessLogger } : {}),
            ...(config.ignoreDefaultArgs
                ? { ignoreDefaultArgs: [...config.ignoreDefaultArgs] }
                : {}),
        });
    }

    /**
     * Stage the enterprise policies into the profile directory ahead of the launch.
     *
     * @param userDataDir - Profile directory the context launches with.
     * @param policies - Enterprise policies payload for the force-installed extension.
     * @returns Absolute path of the staged policies file.
     */
    private stagePolicies(
        userDataDir: string,
        policies: NonNullable<BrowserEnginePersistentLaunchConfig['firefoxPolicies']>,
    ): string {
        mkdirSync(userDataDir, { recursive: true });
        const policiesPath = join(userDataDir, PROFILE_POLICIES_FILE_NAME);
        writeFileSync(policiesPath, JSON.stringify(policies, null, 4), 'utf8');
        return policiesPath;
    }

    /**
     * Merge the staged policies path into the launch environment.
     *
     * The variable is consumed by the browser process itself, so it must live in the child
     * environment; an absolute path is required because the browser may resolve it later.
     *
     * @param environment - Allowlisted environment inherited by the browser process tree.
     * @param policiesPath - Absolute staged policies path, or undefined when none was given.
     * @returns The launch environment, extended with the policies pointer when present.
     */
    private launchEnvironment(
        environment: Record<string, string>,
        policiesPath: string | undefined,
    ): Record<string, string> {
        if (policiesPath === undefined) {
            return environment;
        }
        return { ...environment, [FIREFOX_POLICIES_ENV_VAR]: policiesPath };
    }
}

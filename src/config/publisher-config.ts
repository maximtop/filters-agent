import * as v from 'valibot';

/**
 * Environment keys required by the benchmark publisher.
 */
const REQUIRED_ENV_KEYS = [
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'GITHUB_RUN_ID',
    'GITHUB_SERVER_URL',
    'LAB_REPOSITORY',
    'SUMMARY_ISSUE_NUMBER',
    'AGENT_RUN_DIRECTORY',
    'SUMMARY_MARKDOWN_PATH',
] as const;

/**
 * Validated configuration consumed by the benchmark publisher and post-run scripts.
 */
const PublisherConfigSchema = v.object({
    githubToken: v.pipe(v.string(), v.minLength(1)),
    owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/)),
    repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/)),
    issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
    agentRunDirectory: v.pipe(v.string(), v.minLength(1)),
    summaryMarkdownPath: v.pipe(v.string(), v.minLength(1)),
    expectedUpstreamPromptDigest: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))),
    actionsRunUrl: v.pipe(v.string(), v.url()),
});

/**
 * Publisher configuration derived from the GitHub Actions environment.
 */
export type PublisherConfig = v.InferOutput<typeof PublisherConfigSchema>;

/**
 * Raised when publisher configuration is incomplete, malformed, or points outside the lab.
 */
export class PublisherConfigError extends Error {
    /**
     * Create a publisher configuration error.
     *
     * @param message - Human-readable validation failure.
     */
    constructor(message: string) {
        super(message);
        this.name = 'PublisherConfigError';
    }
}

/**
 * Build the canonical GitHub Actions run URL for a run's own artifacts.
 *
 * @param env - Environment values, injectable for deterministic tests.
 * @returns The run URL when `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are all
 *   present and non-blank — one trailing slash of the server URL removed — or `undefined` when any
 *   of them is absent, so a caller without runner variables carries no artifacts link at all.
 */
export function buildActionsRunUrl(env: Record<string, string | undefined>): string | undefined {
    const serverUrl = env.GITHUB_SERVER_URL?.trim().replace(/\/$/, '');
    const repository = env.GITHUB_REPOSITORY?.trim();
    const runId = env.GITHUB_RUN_ID?.trim();
    if (!serverUrl || !repository || !runId) {
        return undefined;
    }
    return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

/**
 * Load publisher settings and fail closed unless the workflow repository matches the allowlist.
 *
 * @param env - Environment values, injectable for deterministic tests.
 * @returns Validated publisher configuration.
 */
export function loadPublisherConfig(
    env: Record<string, string | undefined> = process.env,
): PublisherConfig {
    const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim());
    if (missing.length > 0) {
        throw new PublisherConfigError(
            `Missing required publisher environment variables: ${missing.join(', ')}`,
        );
    }

    const workflowRepository = env.GITHUB_REPOSITORY!.trim();
    const labRepository = env.LAB_REPOSITORY!.trim();
    if (workflowRepository !== labRepository) {
        throw new PublisherConfigError(
            `GITHUB_REPOSITORY ${workflowRepository} does not match LAB_REPOSITORY ` +
                `${labRepository}; refusing GitHub writes`,
        );
    }

    const repositoryParts = workflowRepository.split('/');
    const raw = {
        githubToken: env.GITHUB_TOKEN!.trim(),
        owner: repositoryParts.length === 2 ? repositoryParts[0] : '',
        repo: repositoryParts.length === 2 ? repositoryParts[1] : '',
        issueNumber: Number(env.SUMMARY_ISSUE_NUMBER),
        agentRunDirectory: env.AGENT_RUN_DIRECTORY!.trim(),
        summaryMarkdownPath: env.SUMMARY_MARKDOWN_PATH!.trim(),
        ...(env.EXPECTED_UPSTREAM_PROMPT_DIGEST?.trim()
            ? { expectedUpstreamPromptDigest: env.EXPECTED_UPSTREAM_PROMPT_DIGEST.trim() }
            : {}),
        actionsRunUrl: buildActionsRunUrl(env),
    };
    const result = v.safeParse(PublisherConfigSchema, raw);
    if (!result.success) {
        const details = result.issues.map((issue) => issue.message).join('; ');
        throw new PublisherConfigError(`Invalid publisher configuration: ${details}`);
    }
    return result.output;
}

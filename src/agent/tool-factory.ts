import type { GithubReadConfig, RawIssue } from '../github/fetch-issue';
import { stripBenchmarkIssueMarker } from '../github/benchmark-issue-marker';
import { ToolRegistry } from './tool-registry';
import { ToolName } from './tool-names';
import { registeredParameters } from './registered-parameters';
import { createResolvePlacementTool } from './placement-tool';
import { registerRuleSearchTool } from './rule-search-tool';
import { registerAnalyzeScreenshotTool, type VisionToolOptions } from './analyze-screenshot-tool';
import { registerBrowserTools, type BrowserToolOptions } from './browser-tool-bindings';
import { registerGetDetailTool } from './get-detail-tool';
import { generatePlacementMap } from '../repo/placement-map';
import { normalizeRule } from '../repo/rule-normalizer';
import { LintConfigurationFallback } from '../rules/lint-fallback';
import * as v from 'valibot';
import { TraceArtifactStore, type IArtifactStore } from '../tracer/artifact-store';
import type { DeclaredPlacementSet } from '../types/declared-placement';
import { ProblemTypeSchema } from '../types/issue-facts';
import type { PlacementMap } from '../types/repo-context';
import {
    KnowledgeGuidanceSession,
    RULE_GUIDANCE_TOPICS,
    RuleGuidanceQuerySchema,
    RuleGuidanceTopicSchema,
    type RuleGuidanceSource,
} from '../knowledge/rule-guidance';

/**
 * Local issue source used by GitHub-independent investigation runs.
 */
export interface LocalIssueToolOptions {
    /**
     * Parser-ready issue snapshot returned verbatim by the fetch_issue tool.
     */
    localIssue: RawIssue;

    /**
     * Runner-bound reported hostname used to rank repository selector inventory offline.
     */
    reportedDomain?: string;
}

/**
 * Everything one run binds into its tool registry.
 */
export interface ToolRegistryOptions {
    /**
     * GitHub read credentials backing fetch_issue; omit when a local snapshot supplies the issue.
     */
    githubConfig?: GithubReadConfig;

    /**
     * The only issue number the model may fetch in this run.
     */
    allowedIssueNumber: number;

    /**
     * Path to the AdguardFilters checkout; enables search_rules and resolve_placement.
     */
    checkoutPath?: string;

    /**
     * Browser session and analyzer enabling the live evidence and candidate tools.
     */
    browserTools?: BrowserToolOptions;

    /**
     * Artifact store backing get_detail; derived from the browser or vision options when omitted.
     */
    artifactStore?: IArtifactStore;

    /**
     * Browser-independent screenshot-analysis configuration; derived from the browser options when
     * those carry a vision client and this is omitted.
     */
    visionTools?: VisionToolOptions;

    /**
     * Local issue snapshot that replaces the GitHub fetch dependency.
     */
    localIssueTools?: LocalIssueToolOptions;

    /**
     * This run's rule-guidance source — the pinned KnowledgeBase checkout or the instruction's
     * linked documents — enabling lookup_rule_guidance. Both variants carry the `kind` tag the
     * guidance session dispatches on.
     */
    knowledgeGuidance?: RuleGuidanceSource;

    /**
     * Placement map the runtime already walked for this run's list catalog. Supplied, the factory
     * binds the checkout tools to it and never walks the tree itself; omitted, it walks the
     * checkout as before, keeping the single-walk rule under every caller.
     */
    placementMap?: PlacementMap;

    /**
     * The placement this run's instruction declares, rendered once at run start. Supplied, it is
     * the answer `resolve_placement` gives and the file the candidate's edit appends to; omitted,
     * the deterministic language-and-section routing stays in charge.
     */
    declaredPlacement?: DeclaredPlacementSet;
}

/**
 * Normalize a runner-bound hostname without accepting paths, credentials, or ports.
 *
 * @param domain - Trusted hostname candidate supplied by the core runtime.
 * @returns Canonical lowercase hostname, or undefined when invalid.
 */
function normalizeTrustedReportedDomain(domain: string | undefined): string | undefined {
    if (!domain) {
        return undefined;
    }
    const normalized = domain.trim().toLowerCase().replace(/\.$/u, '');
    try {
        const parsed = new URL(`https://${normalized}`);
        return parsed.hostname === normalized && parsed.port.length === 0 ? normalized : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Derive the trusted issue hostname used by deterministic risk scoring.
 *
 * The browser origin is bound by the runner outside the model trust boundary. Tool arguments are
 * deliberately excluded so the model cannot lower risk by claiming a different reported domain.
 *
 * @param browserTools - Optional runner-owned browser configuration.
 * @returns The normalized reported hostname, or undefined when no valid browser URL is bound.
 */
function trustedReportedDomainFromBrowser(
    browserTools: BrowserToolOptions | undefined,
): string | undefined {
    if (!browserTools) {
        return undefined;
    }
    try {
        return new URL(browserTools.allowedOrigin).hostname.toLowerCase().replace(/\.$/u, '');
    } catch {
        return undefined;
    }
}

/**
 * Derive the screenshot-analysis configuration this run should use.
 *
 * An explicit `visionTools` wins; otherwise a browser configuration carrying a vision client
 * supplies the same artifact registry and late-bound symptom accessors.
 *
 * @param options - The run's registry options.
 * @returns The vision configuration, or undefined when the run has no vision client.
 */
function resolveVisionTools(options: ToolRegistryOptions): VisionToolOptions | undefined {
    if (options.visionTools) {
        return options.visionTools;
    }
    const browserTools = options.browserTools;
    if (!browserTools?.vision) {
        return undefined;
    }
    return {
        artifactsDir: browserTools.artifactsDir,
        recorder: browserTools.recorder,
        vision: browserTools.vision,
        reporterSymptom: browserTools.reporterSymptom,
        reporterSymptomKind: browserTools.reporterSymptomKind,
    };
}

/**
 * Derive the artifact store `get_detail` reads and the rule inventory persists through.
 *
 * An explicit store wins; otherwise the browser or vision configuration's artifacts directory and
 * recorder back a trace-registering store, so persisted detail stays reachable from the trace.
 *
 * @param options - The run's registry options.
 * @param visionTools - The resolved screenshot-analysis configuration, when the run has one.
 * @returns The artifact store, or undefined when the run persists nothing.
 */
function resolveArtifactStore(
    options: ToolRegistryOptions,
    visionTools: VisionToolOptions | undefined,
): IArtifactStore | undefined {
    if (options.artifactStore) {
        return options.artifactStore;
    }
    if (options.browserTools) {
        return new TraceArtifactStore(
            options.browserTools.artifactsDir,
            options.browserTools.recorder,
        );
    }
    if (visionTools) {
        return new TraceArtifactStore(visionTools.artifactsDir, visionTools.recorder);
    }
    return undefined;
}

/**
 * The missing-information subject naming each AGLint configuration fallback; the detail carries the
 * loader's own note. The harvest keeps the first of identical subjects, so the two fallbacks get
 * distinct subjects rather than collapsing into one entry, and the record is total over the kinds
 * so a new fallback cannot ship without one.
 */
const LINT_FALLBACK_MISSING_INFORMATION_SUBJECTS: Record<LintConfigurationFallback, string> = {
    [LintConfigurationFallback.NoRepositoryConfig]:
        'AGLint linted rule syntax without a repository configuration',
    [LintConfigurationFallback.StrippedRepositoryConfig]:
        'AGLint linted under a reduced repository configuration',
};

/**
 * Create a ToolRegistry pre-populated with all agent tools.
 *
 * Always registers four pure tools: `fetch_issue`, `policy_check`, `score_risk`, `lint_rule`. When
 * `checkoutPath` is provided, additionally registers `search_rules` and `resolve_placement` against
 * the checkout. When `browserTools` is provided, additionally registers browser evidence and
 * validation tools. If vision configuration is present, it also registers `analyze_screenshot`.
 *
 * This factory eliminates duplicated registration between `main.ts` (analyze handler) and
 * `replay-runner.ts` (Finding 2).
 *
 * @param options - Everything this run binds into its registry.
 * @returns A fully registered ToolRegistry ready for the agent loop.
 */
export async function createToolRegistry(options: ToolRegistryOptions): Promise<ToolRegistry> {
    const { allowedIssueNumber, githubConfig, checkoutPath, browserTools, localIssueTools } =
        options;
    if (!Number.isInteger(allowedIssueNumber) || allowedIssueNumber < 1) {
        throw new Error(`Invalid allowed issue number: ${allowedIssueNumber}`);
    }
    const registry = new ToolRegistry();
    const trustedReportedDomain =
        trustedReportedDomainFromBrowser(browserTools) ??
        normalizeTrustedReportedDomain(localIssueTools?.reportedDomain);
    const guidanceSession = options.knowledgeGuidance
        ? new KnowledgeGuidanceSession(options.knowledgeGuidance)
        : undefined;
    const requireGuidanceBeforeCandidate = (): Record<string, unknown> | undefined =>
        guidanceSession && !guidanceSession.hasConsultedGuidance()
            ? {
                  error:
                      'Call lookup_rule_guidance before evaluating or validating the first ' +
                      'candidate rule.',
                  requiredTool: ToolName.LookupRuleGuidance,
                  allowedTopics: RULE_GUIDANCE_TOPICS,
              }
            : undefined;
    const resolvedVisionTools = resolveVisionTools(options);
    const resolvedArtifactStore = resolveArtifactStore(options, resolvedVisionTools);

    if (guidanceSession) {
        registry.register({
            definition: {
                type: 'function',
                function: {
                    name: ToolName.LookupRuleGuidance,
                    description:
                        "Read one bounded topic from this run's rule-guidance documents. This must " +
                        'be called before evaluating the first candidate. Prefer domain-scoped ' +
                        'element hiding for removable ads and leftovers; consult CSS injection ' +
                        'only when ordinary hiding is proven insufficient. A document too long to ' +
                        'return whole comes back as the sections matching the topic plus an index ' +
                        'of every heading it has; pass `query` with the words naming what you need ' +
                        'to narrow it to those sections, and call again for another part.',
                    parameters: registeredParameters(ToolName.LookupRuleGuidance),
                },
            },
            handler: async (args) => {
                const parsed = v.safeParse(RuleGuidanceTopicSchema, args.topic);
                if (!parsed.success) {
                    return {
                        error: `Unsupported guidance topic: ${String(args.topic)}`,
                        allowedTopics: RULE_GUIDANCE_TOPICS,
                    };
                }
                const query = v.safeParse(RuleGuidanceQuerySchema, args.query);
                return guidanceSession.lookup(
                    parsed.output,
                    query.success ? query.output : undefined,
                ) as unknown as Record<string, unknown>;
            },
        });
    }

    // ── fetch_issue (always) ───────────────────────────────────────────────
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.FetchIssue,
                description:
                    'Fetch the current issue snapshot by number. Returns the issue body, labels, ' +
                    'state, assignee, and prompt-safe comments.',
                parameters: registeredParameters(ToolName.FetchIssue),
            },
        },
        handler: async (args) => {
            const num =
                typeof args.issueNumber === 'number' ? args.issueNumber : Number(args.issueNumber);
            if (!Number.isInteger(num) || num < 1) {
                throw new Error(`Invalid issue number: ${args.issueNumber}`);
            }
            if (num !== allowedIssueNumber) {
                throw new Error(
                    `fetch_issue is restricted to issue ${allowedIssueNumber} for this run`,
                );
            }
            let raw: RawIssue;
            if (localIssueTools) {
                raw = {
                    ...localIssueTools.localIssue,
                    body: stripBenchmarkIssueMarker(localIssueTools.localIssue.body),
                };
                if (raw.number !== allowedIssueNumber) {
                    throw new Error(
                        `Local issue snapshot ${raw.number} does not match allowed issue ` +
                            allowedIssueNumber,
                    );
                }
            } else {
                if (!githubConfig) {
                    throw new Error('GitHub credentials or a local issue snapshot are required');
                }
                const { fetchIssue } = await import('../github/fetch-issue');
                raw = await fetchIssue(githubConfig, num);
            }
            return { raw };
        },
    });

    // ── policy_check (always) ──────────────────────────────────────────────
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.PolicyCheck,
                description:
                    'Check whether filter policy allows rule generation for a reported issue. Returns propose_close, needs_human_review, or allow_rule_generation with cited reasons.',
                parameters: registeredParameters(ToolName.PolicyCheck),
            },
        },
        handler: async (args) => {
            const { policyCheck } = await import('../policy/policy-gate');
            const parsedProblemType = v.safeParse(ProblemTypeSchema, args.problemType);
            const problemType = parsedProblemType.success ? parsedProblemType.output : 'unknown';
            return policyCheck({
                firstPartyAd: Boolean(args.firstPartyAd),
                paywall: Boolean(args.paywall),
                antiAdblockWall: Boolean(args.antiAdblockWall),
                germanAntiAdblock: Boolean(args.germanAntiAdblock),
                evidenceRefs: Array.isArray(args.evidenceRefs)
                    ? args.evidenceRefs.filter((e): e is string => typeof e === 'string')
                    : [],
                problemType,
            });
        },
    });

    // ── score_risk (always) ────────────────────────────────────────────────
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.ScoreRisk,
                description:
                    'Score a candidate filter rule for risk. Returns score (0-5), level (low/medium/high/blocker), reasons, and required action.',
                parameters: registeredParameters(ToolName.ScoreRisk),
            },
        },
        handler: async (args) => {
            const guidanceRequirement = requireGuidanceBeforeCandidate();
            if (guidanceRequirement) {
                return guidanceRequirement;
            }
            const { scoreRisk } = await import('../risk/risk-scorer');
            if (typeof args.rule !== 'string' || args.rule.trim().length === 0) {
                return { error: 'Invalid input: rule must be a non-empty string' };
            }
            return scoreRisk(args.rule, { trustedReportedDomain });
        },
    });

    // ── lint_rule (always) ─────────────────────────────────────────────────
    registry.register({
        definition: {
            type: 'function',
            function: {
                name: ToolName.LintRule,
                description:
                    'Validate filter rule syntax. Returns valid, parsedKind, problems, and deterministic correction guidance.',
                parameters: registeredParameters(ToolName.LintRule),
            },
        },
        handler: async (args) => {
            const guidanceRequirement = requireGuidanceBeforeCandidate();
            if (guidanceRequirement) {
                return guidanceRequirement;
            }
            const { lintRule, CSS_WITH_SCRIPTLET_SEPARATOR_CODE } =
                await import('../rules/aglint-linter');
            if (typeof args.rule !== 'string' || args.rule.trim().length === 0) {
                return { error: 'Invalid input: rule must be a non-empty string' };
            }
            const lintResult = lintRule(args.rule, { repoRoot: checkoutPath });
            const hasCssWithScriptletSeparator = lintResult.problems.some(
                (problem) => problem.code === CSS_WITH_SCRIPTLET_SEPARATOR_CODE,
            );
            return {
                ...lintResult,
                parsedKind: normalizeRule(args.rule).kind,
                deterministicGuidance: hasCssWithScriptletSeparator
                    ? [
                          'Use #$# for CSS injection, then call lint_rule and apply_rule again. Do not use #%# or #?# for CSS resizing.',
                      ]
                    : [],
                // A configuration fallback reaches the run evidence and the report through the
                // missing-information channel the harvest reads.
                ...(lintResult.fallback !== undefined
                    ? {
                          missingInformation: {
                              subject:
                                  LINT_FALLBACK_MISSING_INFORMATION_SUBJECTS[
                                      lintResult.fallback.kind
                                  ],
                              detail: lintResult.fallback.message,
                          },
                      }
                    : {}),
            };
        },
    });

    // ── Checkout-dependent tools ───────────────────────────────────────────
    if (checkoutPath) {
        // One placement map serves both checkout tools; generating it a second time would re-read
        // the whole filter tree for facts the first pass already has. The runtime's catalog walk
        // supplies its map when one exists, so a run walks the tree exactly once.
        const map = options.placementMap ?? generatePlacementMap(checkoutPath);
        const ownedListPaths = new Set(map.files.map((entry) => entry.relativePath));
        registerRuleSearchTool(registry, {
            checkoutPath,
            map,
            trustedReportedDomain,
            artifactStore: resolvedArtifactStore,
        });
        registry.register(
            createResolvePlacementTool({
                checkoutPath,
                map,
                ownedListPaths,
                requireGuidance: requireGuidanceBeforeCandidate,
                ...(options.declaredPlacement === undefined
                    ? {}
                    : { declaredPlacement: options.declaredPlacement }),
            }),
        );
    }

    if (browserTools) {
        await registerBrowserTools(registry, browserTools);
    }

    if (resolvedVisionTools) {
        registerAnalyzeScreenshotTool(registry, resolvedVisionTools);
    }

    if (resolvedArtifactStore) {
        registerGetDetailTool(registry, resolvedArtifactStore);
    }

    return registry;
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindDeclaredPlacement } from '../repo/declared-placement';
import {
    PlacementRuleType,
    PLACEMENT_RULE_TYPE_VALUES,
    type PlacementInput,
} from '../repo/placement-resolver';
import type { DeclaredPlacement } from '../types/declared-placement';
import { PlacementBasis } from '../types/placement-basis';
import type { PlacementMap } from '../types/repo-context';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import { registeredParameters } from './registered-parameters';
import { ToolName } from './tool-names';
import type { ToolHandler } from './tool-registry';

/**
 * An existing similar rule entry as received from the LLM tool call arguments.
 */
interface ExistingSimilarRuleEntry {
    /**
     * The existing rule text.
     */
    rule: string;

    /**
     * The file path where the existing rule is located.
     */
    filePath: string;
}

/**
 * A planned rule insertion the tool reports to the model: the exact 1-based line, the line the rule
 * would precede, and how the position was chosen.
 */
export interface PlannedInsertion {
    /**
     * The plan exists; the fields below describe it.
     */
    available: true;

    /**
     * Repository file the planner bound the rule to; may differ from the resolver's pick when a
     * shared-rule owner wins.
     */
    filePath: string;

    /**
     * Discriminator: a new line is inserted.
     */
    kind: typeof RepositoryEditKind.Insert;

    /**
     * How the insertion position was chosen.
     */
    basis: PlacementBasis;

    /**
     * 1-based line the rule would occupy. Absent only when the target file vanished between
     * planning and measurement, which a pinned checkout does not do in practice.
     */
    insertionLine?: number;

    /**
     * Exact line the rule is planned to precede; absent for an end-of-file append.
     */
    insertBeforeRule?: string;

    /**
     * Comment line the edit writes immediately before the rule, when the run instruction's
     * placement declaration asks for one.
     */
    commentLine?: string;
}

/**
 * A planned domain extension: the candidate's domain joins an existing rule instead of adding a new
 * line.
 */
export interface PlannedDomainExtension {
    /**
     * The plan exists; the fields below describe it.
     */
    available: true;

    /**
     * Repository file holding the rule being extended.
     */
    filePath: string;

    /**
     * Discriminator: an existing rule's domain list is extended.
     */
    kind: typeof RepositoryEditKind.ExtendDomains;

    /**
     * 1-based line of the rule being extended.
     */
    line: number;

    /**
     * Exact rule being extended.
     */
    originalRule: string;

    /**
     * The rule as it would read with the candidate's domain included.
     */
    replacementRule: string;

    /**
     * What the agent does with this plan: it keeps its own single-domain candidate.
     */
    candidateContract: string;
}

/**
 * What an extension plan asks of the agent, stated in the plan itself.
 *
 * The plan shows the merged line, and a model that sees a ready replacement takes it for the thing
 * to test and submit. On nottinghampost.com it validated and submitted
 * `nottinghampost.com,devonlive.com,…##div[data-tmdatatrack-type="commercial"]`, vision verified
 * it, and the candidate safety gate then refused the draft for carrying four positive scopes — a
 * verified fix lost to a contract nothing had told the model. The host performs the merge; the
 * candidate stays the rule scoped to the reported domain, and that is the rule the experiment
 * verifies.
 */
export const EXTEND_DOMAINS_CANDIDATE_CONTRACT =
    'The host writes replacementRule into the file itself. Keep candidateRule scoped to the ' +
    'reported domain alone in apply_rule and in finish_fix: that single-domain rule is what the ' +
    'experiment verifies, and a candidate that carries the other domains is refused.';

/**
 * The planner failed closed (for example on an ambiguous shared target); the agent reconsiders the
 * file or proceeds knowing candidate build will fail closed the same way.
 */
export interface PlacementPlanUnavailable {
    /**
     * No plan exists for the resolved file.
     */
    available: false;

    /**
     * Safe upstream detail of the planner failure.
     */
    reason: string;
}

/**
 * The placement plan variants the tool reports alongside the map-based resolution.
 */
export type PlacementPlan = PlannedInsertion | PlannedDomainExtension | PlacementPlanUnavailable;

/**
 * Stable rejection code of a `resolve_placement` call whose target — resolution pick or
 * similar-rule hint — names a list that is not one of the run repository's own files. Third-party
 * lists the reporter enabled are executable context only, never editable targets.
 */
export const NON_OWNED_LIST_TARGET_ERROR = 'non-owned-list-target';

/**
 * Check whether a model-supplied file path names one of the repository's own list files.
 *
 * Mirrors the placement resolver's own hint matching — exact or checkout-suffixed,
 * case-insensitive, separator-normalized — so a hint the resolver would honor for an owned file is
 * never rejected here for spelling differences alone.
 *
 * @param ownedPaths - Checkout-relative paths of the repository's own list files.
 * @param candidatePath - The untrusted model-supplied path to test.
 * @returns True when the path resolves to an owned list file.
 */
function namesOwnedPath(ownedPaths: ReadonlySet<string>, candidatePath: string): boolean {
    const normalized = candidatePath.replace(/\\/gu, '/').toLowerCase();
    for (const ownedPath of ownedPaths) {
        const owned = ownedPath.replace(/\\/gu, '/').toLowerCase();
        if (normalized === owned || normalized.endsWith(`/${owned}`)) {
            return true;
        }
    }
    return false;
}

/**
 * Build the stable rejection payload for a placement target outside the owned list set.
 *
 * @param refusedTarget - The checkout-relative or model-supplied path that was refused.
 * @returns The bounded rejection naming the refused target.
 */
function nonOwnedTargetRejection(refusedTarget: string): Record<string, unknown> {
    return {
        error: NON_OWNED_LIST_TARGET_ERROR,
        refusedTarget,
        detail:
            "Rules may be proposed only in the repository's own list files; " +
            `'${refusedTarget}' is not one of them.`,
    };
}

/**
 * Measure the 1-based line an anchorless append would land on, using the same final-newline
 * semantics as the candidate diff builder: a trailing newline does not open a phantom last line.
 *
 * @param checkoutPath - Pinned filters checkout root.
 * @param filePath - Repository-relative planned target file.
 * @returns The 1-based end-of-file insertion line, or undefined when the file cannot be read -
 *   possible only if the just-planned file vanished from the pinned checkout.
 */
function appendLine(checkoutPath: string, filePath: string): number | undefined {
    let content: string;
    try {
        content = readFileSync(join(checkoutPath, filePath), 'utf8');
    } catch {
        return undefined;
    }
    const normalized = content.replace(/\r\n?/g, '\n');
    const lines = normalized.endsWith('\n')
        ? normalized.slice(0, -1).split('\n')
        : normalized.split('\n');
    return lines.length + 1;
}

/**
 * Dependencies of the `resolve_placement` tool.
 */
export interface ResolvePlacementToolOptions {
    /**
     * Pinned AdguardFilters checkout root.
     */
    checkoutPath: string;

    /**
     * Placement map generated from that checkout.
     */
    map: PlacementMap;

    /**
     * Checkout-relative paths of the repository's own list files, derived from the same placement
     * map: proposing a place and naming one are allowed only inside these.
     */
    ownedListPaths: ReadonlySet<string>;

    /**
     * Guidance gate: a rejection payload while rule guidance has not been consulted yet.
     */
    requireGuidance: () => Record<string, unknown> | undefined;

    /**
     * The run instruction's placement declaration, rendered for this run. Supplied, it is the
     * answer to every placement question this run asks: the repository has said where its rules go
     * and the map-based routing never runs.
     */
    declaredPlacement?: DeclaredPlacement;
}

/**
 * Build the `resolve_placement` tool: map-based filter/section routing plus the checkout-backed
 * insertion plan, so the model sees the exact line a candidate would land on. The plan is advisory
 * visibility only - candidate build reruns the same pure planner on the same pinned checkout, and
 * the model cannot dictate a position.
 *
 * A run whose instruction declares a placement answers with that declaration instead: the declared
 * file at full confidence with no alternative, and an end-of-file insertion carrying the declared
 * comment line.
 *
 * @param options - Pinned checkout root, its placement map, the guidance gate shared with the other
 *   candidate-evaluation tools, and the run's declared placement when it has one.
 * @returns The registrable tool definition and handler.
 */
export function createResolvePlacementTool(options: ResolvePlacementToolOptions): ToolHandler {
    const { checkoutPath, map, ownedListPaths, requireGuidance, declaredPlacement } = options;
    return {
        definition: {
            type: 'function',
            function: {
                name: ToolName.ResolvePlacement,
                description:
                    'Determine which filter file and section a candidate rule belongs in, ' +
                    'and the exact line it would be inserted at.',
                parameters: registeredParameters(ToolName.ResolvePlacement),
            },
        },
        handler: async (args) => {
            const guidanceRequirement = requireGuidance();
            if (guidanceRequirement) {
                return guidanceRequirement;
            }
            const { resolvePlacement } = await import('../repo/placement-resolver');
            const ruleTypeRaw = typeof args.ruleType === 'string' ? args.ruleType : '';
            const ruleType: PlacementRuleType = (
                PLACEMENT_RULE_TYPE_VALUES as readonly string[]
            ).includes(ruleTypeRaw)
                ? (ruleTypeRaw as PlacementRuleType)
                : PlacementRuleType.Network;
            const resolutionInput: PlacementInput = {
                siteLanguage: typeof args.siteLanguage === 'string' ? args.siteLanguage : 'en',
                siteRegion: typeof args.siteRegion === 'string' ? args.siteRegion : 'US',
                ruleType,
                targetDomain: typeof args.targetDomain === 'string' ? args.targetDomain : '',
                requestDomain:
                    typeof args.requestDomain === 'string' ? args.requestDomain : undefined,
                issueLabels: Array.isArray(args.issueLabels)
                    ? args.issueLabels.filter((l): l is string => typeof l === 'string')
                    : [],
                product: typeof args.product === 'string' ? args.product : undefined,
                cyrillicBoth:
                    typeof args.cyrillicBoth === 'boolean' ? args.cyrillicBoth : undefined,
                existingSimilarRules: Array.isArray(args.existingSimilarRules)
                    ? args.existingSimilarRules.filter(
                          (e): e is ExistingSimilarRuleEntry =>
                              typeof (e as Record<string, unknown>).rule === 'string' &&
                              typeof (e as Record<string, unknown>).filePath === 'string',
                      )
                    : [],
            };
            // The model may only steer placement toward the repository's own files: a hint naming
            // a third-party list is refused outright, naming the target, instead of the resolver
            // silently ignoring it.
            for (const similar of resolutionInput.existingSimilarRules) {
                if (!namesOwnedPath(ownedListPaths, similar.filePath)) {
                    return nonOwnedTargetRejection(similar.filePath);
                }
            }
            const declaredTarget =
                declaredPlacement === undefined
                    ? undefined
                    : bindDeclaredPlacement(checkoutPath, declaredPlacement);
            const resolution = resolvePlacement(resolutionInput, map, declaredTarget);
            // Defense in depth over the model trust boundary: the map only names checkout files,
            // so a resolved pick is owned by construction — the check exists to keep that
            // construction honest even if the resolver's target inventory ever widens. A declared
            // placement is run configuration rather than a model claim, and its file may not be in
            // the checkout at all yet, so ownership has nothing to say about it.
            if (
                declaredPlacement === undefined &&
                resolution.filePath.length > 0 &&
                !namesOwnedPath(ownedListPaths, resolution.filePath)
            ) {
                return nonOwnedTargetRejection(resolution.filePath);
            }
            const candidateRule = typeof args.candidateRule === 'string' ? args.candidateRule : '';
            const { planRepositoryEdit } = await import('../repo/repository-edit');
            let plan: PlacementPlan;
            try {
                const planned = planRepositoryEdit(
                    checkoutPath,
                    resolution.filePath,
                    candidateRule,
                    resolutionInput.existingSimilarRules.map((entry) => entry.rule),
                    declaredPlacement,
                );
                if (planned.edit.kind === RepositoryEditKind.Insert) {
                    const plannedLine =
                        planned.edit.insertionPoint === undefined
                            ? appendLine(checkoutPath, planned.filePath)
                            : planned.edit.insertionPoint + 1;
                    // A declared comment takes the planned position and the rule follows it, so
                    // the reported line stays the line the rule itself occupies.
                    const insertionLine =
                        plannedLine === undefined || planned.edit.precedingComment === undefined
                            ? plannedLine
                            : plannedLine + 1;
                    plan = {
                        available: true,
                        filePath: planned.filePath,
                        kind: RepositoryEditKind.Insert,
                        basis: planned.edit.basis ?? PlacementBasis.AppendEof,
                        ...(insertionLine === undefined ? {} : { insertionLine }),
                        ...(planned.edit.anchorRule === undefined
                            ? {}
                            : { insertBeforeRule: planned.edit.anchorRule }),
                        ...(planned.edit.precedingComment === undefined
                            ? {}
                            : { commentLine: planned.edit.precedingComment }),
                    };
                } else if (planned.edit.kind === RepositoryEditKind.ExtendDomains) {
                    plan = {
                        available: true,
                        filePath: planned.filePath,
                        kind: RepositoryEditKind.ExtendDomains,
                        line: planned.edit.line,
                        originalRule: planned.edit.originalRule,
                        replacementRule: planned.edit.replacementRule,
                        candidateContract: EXTEND_DOMAINS_CANDIDATE_CONTRACT,
                    };
                } else {
                    plan = {
                        available: false,
                        reason: `Unexpected planned edit kind: ${planned.edit.kind}`,
                    };
                }
            } catch (error) {
                // Diagnosable data, not a crash: the agent reconsiders the file or proceeds
                // knowing the host will fail closed at candidate build.
                plan = {
                    available: false,
                    reason: error instanceof Error ? error.message : String(error),
                };
            }
            return { ...resolution, plan };
        },
    };
}

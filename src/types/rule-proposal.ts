import * as v from 'valibot';

/**
 * Severity tier assigned to a candidate rule's blast-radius risk assessment.
 */
export const RiskLevel = {
    /**
     * Safe to publish without additional review.
     */
    Low: 'low',

    /**
     * Publishable, but worth a reviewer's attention.
     */
    Medium: 'medium',

    /**
     * Requires explicit human sign-off before publication.
     */
    High: 'high',

    /**
     * Must not be published automatically under any circumstance.
     */
    Blocker: 'blocker',
} as const;

/**
 * Every RiskLevel value, for schemas and exhaustive listings.
 */
export const RISK_LEVEL_VALUES = Object.values(RiskLevel);

/**
 * Severity tier of one candidate rule's risk assessment.
 */
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RiskLevelSchema = v.picklist(RISK_LEVEL_VALUES);

/**
 * The publication path a candidate rule's risk assessment requires.
 */
export const RequiredAction = {
    /**
     * May be opened as a pull request without human involvement.
     */
    AutoPr: 'auto_pr',

    /**
     * May be opened as a pull request, but must carry a visible risk warning.
     */
    PrWithWarning: 'pr_with_warning',

    /**
     * Must not be turned into a pull request without a human driving it.
     */
    HumanOnly: 'human_only',
} as const;

/**
 * Every RequiredAction value, for schemas and exhaustive listings.
 */
export const REQUIRED_ACTION_VALUES = Object.values(RequiredAction);

/**
 * Publication path required for one candidate rule's risk assessment.
 */
export type RequiredAction = (typeof RequiredAction)[keyof typeof RequiredAction];

export const RequiredActionSchema = v.picklist(REQUIRED_ACTION_VALUES);

export const RuleRiskSchema = v.object({
    score: v.pipe(v.number(), v.minValue(0), v.maxValue(5)),
    level: RiskLevelSchema,
    reasons: v.array(v.string()),
    blastRadiusFlags: v.array(v.string()),
    requiredAction: RequiredActionSchema,
});

/**
 * How a candidate rule relates to an existing rule found by the duplicate check.
 */
export const DuplicateClass = {
    /**
     * The candidate is byte-for-byte identical to an existing rule.
     */
    Exact: 'exact',

    /**
     * The candidate targets the same thing as an existing rule through different syntax.
     */
    Semantic: 'semantic',

    /**
     * An existing broader rule already covers everything the candidate would block.
     */
    Subsumed: 'subsumed',

    /**
     * The candidate contradicts an existing rule's effect.
     */
    Conflict: 'conflict',

    /**
     * A matching rule exists, but in a different filter than the candidate targets.
     */
    CrossFilter: 'cross-filter',

    /**
     * No related existing rule was found.
     */
    None: 'none',
} as const;

/**
 * Every DuplicateClass value, for schemas and exhaustive listings.
 */
export const DUPLICATE_CLASS_VALUES = Object.values(DuplicateClass);

/**
 * Relationship of one candidate rule to an existing rule found by the duplicate check.
 */
export type DuplicateClass = (typeof DuplicateClass)[keyof typeof DuplicateClass];

export const DuplicateClassSchema = v.picklist(DUPLICATE_CLASS_VALUES);

export const DuplicateCheckResultSchema = v.object({
    classification: DuplicateClassSchema,
    matches: v.array(v.object({ rule: v.string(), filePath: v.string() })),
});

// Deliberately no `insertionPoint`: the model copies the resolver fields exactly, the resolver
// makes no positional claim, and the in-file position is host-planned at candidate build. Old
// artifacts that still carry the field parse fine - v.object drops unknown keys.
export const PlacementResultSchema = v.object({
    filter: v.string(),
    filePath: v.string(),
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    alternatives: v.array(v.string()),
});

export const ProductCompatibilitySchema = v.object({
    extension: v.boolean(),
});

/**
 * Proposal-level rule types; scriptlets stay inside the broad `cosmetic` category.
 */
export const RuleType = {
    Network: 'network',
    Cosmetic: 'cosmetic',
} as const;

/**
 * Every proposal rule type value, for schemas and exhaustive listings.
 */
export const RULE_TYPE_VALUES = Object.values(RuleType);

/**
 * Proposal-level rule type of one candidate.
 */
export type RuleType = (typeof RuleType)[keyof typeof RuleType];

export const RuleTypeSchema = v.picklist(RULE_TYPE_VALUES);

export const RuleProposalSchema = v.object({
    rule: v.string(),
    ruleType: RuleTypeSchema,
    risk: RuleRiskSchema,
    placement: PlacementResultSchema,
    duplicateCheck: DuplicateCheckResultSchema,
    productCompatibility: ProductCompatibilitySchema,
});

export type RuleRisk = v.InferOutput<typeof RuleRiskSchema>;
export type RuleProposal = v.InferOutput<typeof RuleProposalSchema>;

import * as v from 'valibot';
import { BrowserDisplayName } from '../types/browser-display-name';
import type { IssueFacts } from '../types/issue-facts';
import { BoundedIdentifierSchema, ExecutorNameSchema, type ExecutorName } from './executor-name';
import {
    ExecutorPreparationState,
    ExecutorPreparedProvenanceSchema,
    ExecutorPreparationOutcomeSchema,
    ExecutorPreparationSchema,
    type ExecutorPreparationOutcome,
} from './executor-preparation';
import {
    ExecutableFilterDecisionSchema,
    NonExecutableFilterCode,
    decideExecutableFilters,
    type ExecutableFilterDecision,
} from './official-filter-catalog';

/**
 * Capability supported by one filtering environment.
 */
export const EnvironmentCapability = {
    /**
     * The environment can drive a controlled browser to the reported page.
     */
    BrowserNavigation: 'browser_navigation',

    /**
     * The environment can enable, disable, or otherwise steer what filtering runs.
     */
    FilteringControl: 'filtering_control',

    /**
     * Filtering is enforced by the AdGuard browser extension under test.
     */
    ExtensionFiltering: 'extension_filtering',

    /**
     * Filtering is enforced by a command-line filtering proxy instead of the extension.
     */
    CliFiltering: 'cli_filtering',

    /**
     * The environment can apply a proposed candidate rule for verification.
     */
    CandidateApplication: 'candidate_application',

    /**
     * The environment can verify the published filter baseline it started from.
     */
    BaselineIntegrity: 'baseline_integrity',

    /**
     * The environment can produce the three-phase A/B/C validation proof.
     */
    PhaseProof: 'phase_proof',

    /**
     * The environment can install the filtering proxy CLI.
     */
    CliInstallation: 'cli_installation',

    /**
     * The environment can activate an installed filtering proxy CLI.
     */
    CliActivation: 'cli_activation',
} as const;

/**
 * Every EnvironmentCapability value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_CAPABILITY_VALUES = Object.values(EnvironmentCapability);

export const EnvironmentCapabilitySchema = v.picklist(ENVIRONMENT_CAPABILITY_VALUES);

/**
 * Preparation model of one filtering environment descriptor: how the executor behind the descriptor
 * becomes ready, or why it cannot.
 */
export const EnvironmentPreparationState = {
    /**
     * The executor needs no preparation pass: a locked selection can execute immediately.
     */
    NotStarted: 'not_started',

    /**
     * The executor runs a preparation pass after the lock and before execution.
     */
    Preparable: 'preparable',

    /**
     * The executor adapter cannot be prepared in this delivery slice.
     */
    AdapterUnavailable: 'adapter_unavailable',
} as const;

/**
 * Every EnvironmentPreparationState value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_PREPARATION_STATE_VALUES = Object.values(EnvironmentPreparationState);

export const EnvironmentPreparationStateSchema = v.picklist(ENVIRONMENT_PREPARATION_STATE_VALUES);

/**
 * EnvironmentPreparationState value.
 */
export type EnvironmentPreparationState =
    (typeof EnvironmentPreparationState)[keyof typeof EnvironmentPreparationState];

/**
 * Whether a filtering environment adapter can currently be selected.
 */
export const FilteringEnvironmentAvailability = {
    /**
     * The adapter can be selected and prepared for this run.
     */
    Available: 'available',

    /**
     * The adapter cannot be selected in this delivery slice.
     */
    Unavailable: 'unavailable',
} as const;

/**
 * Every FilteringEnvironmentAvailability value, for schemas and exhaustive listings.
 */
export const FILTERING_ENVIRONMENT_AVAILABILITY_VALUES = Object.values(
    FilteringEnvironmentAvailability,
);

/**
 * Stable reason the locked environment selection could not fully execute.
 */
export const EnvironmentLimitationCode = {
    /**
     * The executor adapter is not available in this delivery slice. Reachable only for descriptors
     * shipped `unavailable` — the defaults carry no limitation.
     */
    ExecutorUnavailable: 'executor_unavailable',

    /**
     * The locked environment does not advertise a capability the request required.
     */
    RequiredCapabilityUnavailable: 'required_capability_unavailable',

    /**
     * Automatic executor preparation did not become ready.
     */
    EnvironmentPreparationFailed: 'environment_preparation_failed',

    /**
     * The prepared environment failed to activate for the run.
     */
    EnvironmentActivationFailed: 'environment_activation_failed',

    /**
     * The reported filter selection resolved to no executable official filter baseline.
     */
    FilterSelectionNotExecutable: 'filter_selection_not_executable',
} as const;

/**
 * Every EnvironmentLimitationCode value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_LIMITATION_CODE_VALUES = Object.values(EnvironmentLimitationCode);

/**
 * Durable limitation-code acceptance: the finite codes this generation writes first, plus the
 * bounded identifier shape that admits the renamed codes persisted by pre-registry artifacts — the
 * persisted run-result read-back must keep parsing what earlier runs wrote, while fresh writes
 * always come from {@link EnvironmentLimitationCode}.
 */
export const EnvironmentLimitationCodeSchema = v.union([
    v.picklist(ENVIRONMENT_LIMITATION_CODE_VALUES),
    BoundedIdentifierSchema,
]);

/**
 * EnvironmentLimitationCode value.
 */
export type EnvironmentLimitationCode =
    (typeof EnvironmentLimitationCode)[keyof typeof EnvironmentLimitationCode];

/**
 * EnvironmentLimitationCode or a bounded historical code read back from a persisted artifact.
 */
export type EnvironmentLimitationCodeRead = v.InferOutput<typeof EnvironmentLimitationCodeSchema>;

/**
 * Reserved outcome the model may ask for instead of one executor: the run reproduces no filtering
 * at all and records the unsupported-product verdict.
 */
export const EnvironmentSelectionReservedCase = {
    /**
     * The agent declares the reported product unsupported, locking no environment.
     */
    UnsupportedProductCase: 'unsupported_product_case',
} as const;

/**
 * Every EnvironmentSelectionReservedCase value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_SELECTION_RESERVED_CASE_VALUES = Object.values(
    EnvironmentSelectionReservedCase,
);

/**
 * EnvironmentSelectionReservedCase value.
 */
export type EnvironmentSelectionReservedCase =
    (typeof EnvironmentSelectionReservedCase)[keyof typeof EnvironmentSelectionReservedCase];

/**
 * EnvironmentSelectionKind schema: the reserved unsupported-product case, or an executor name. The
 * kind stays open because the executor set is a run input, not a closed list; the reserved case
 * keeps its own literal inside the same schema.
 */
export const EnvironmentSelectionKindSchema = v.union([
    v.literal(EnvironmentSelectionReservedCase.UnsupportedProductCase),
    ExecutorNameSchema,
]);

/**
 * EnvironmentSelectionKind value: the reserved unsupported-product case, or an executor name.
 */
export type EnvironmentSelectionKind =
    | (typeof EnvironmentSelectionReservedCase)[keyof typeof EnvironmentSelectionReservedCase]
    | ExecutorName;

/**
 * Readiness state of the one locked environment selection.
 */
export const EnvironmentSelectionState = {
    /**
     * The preparable executor was selected but its preparation has not finished yet.
     */
    Preparing: 'preparing',

    /**
     * The locked environment advertises every required capability and can execute.
     */
    Ready: 'ready',

    /**
     * The locked environment is missing a required capability or cannot fully execute.
     */
    CapabilityLimited: 'capability_limited',

    /**
     * The agent declared the reported product unsupported; no environment is locked.
     */
    Unsupported: 'unsupported',
} as const;

/**
 * Every EnvironmentSelectionState value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_SELECTION_STATE_VALUES = Object.values(EnvironmentSelectionState);

export const EnvironmentSelectionStateSchema = v.picklist(ENVIRONMENT_SELECTION_STATE_VALUES);

/**
 * EnvironmentSelectionState value.
 */
export type EnvironmentSelectionState =
    (typeof EnvironmentSelectionState)[keyof typeof EnvironmentSelectionState];

/**
 * FilteringEnvironmentAvailability value.
 */
export type FilteringEnvironmentAvailability =
    (typeof FilteringEnvironmentAvailability)[keyof typeof FilteringEnvironmentAvailability];

/**
 * Immutable host capability descriptor shown to the model. The `kind` is the executor name the
 * descriptor belongs to — an executor registration spells its own descriptor, so the accepted
 * identifier set is the open executor-name vocabulary rather than a closed picklist.
 */
export const FilteringEnvironmentDescriptorSchema = v.strictObject({
    kind: ExecutorNameSchema,
    availability: v.picklist(FILTERING_ENVIRONMENT_AVAILABILITY_VALUES),
    preparationState: EnvironmentPreparationStateSchema,
    limitationCode: v.nullable(EnvironmentLimitationCodeSchema),
    capabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
});

const BoundedModelTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(2_000));
const BoundedContextTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

export const AgentIntentEvidenceSchema = v.strictObject({
    source: v.picklist(['issue_body', 'label', 'screenshot', 'browser', 'tool']),
    observation: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

export const AgentIntentAssessmentSchema = v.strictObject({
    issueType: v.picklist([
        'ads',
        'annoyance',
        'incorrect_blocking',
        'anti_adblock',
        'product_specific',
        'unknown',
    ]),
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    evidence: v.pipe(v.array(AgentIntentEvidenceSchema), v.maxLength(12)),
    conflicts: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(1_000))),
        v.maxLength(8),
    ),
});

export const AgentEnvironmentSelectionRequestSchema = v.strictObject({
    kind: EnvironmentSelectionKindSchema,
    requiredCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
    intent: AgentIntentAssessmentSchema,
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

export const DeclaredIssueContextSchema = v.strictObject({
    issueFormType: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
    typeLabels: v.pipe(
        v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
        v.maxLength(20),
    ),
});

export const ReportedExecutionContextSchema = v.strictObject({
    product: v.nullable(BoundedContextTextSchema),
    os: v.nullable(BoundedContextTextSchema),
    browser: v.nullable(BoundedContextTextSchema),
});

export const ActualExecutionContextSchema = v.strictObject({
    kind: ExecutorNameSchema,
    product: BoundedContextTextSchema,
    browser: BoundedContextTextSchema,
    productVersion: v.nullable(BoundedContextTextSchema),
});

const ActualExecutionContextInputSchema = v.strictObject({
    product: BoundedContextTextSchema,
    browser: BoundedContextTextSchema,
    productVersion: v.optional(BoundedContextTextSchema),
});

export const CapabilityLimitSchema = v.strictObject({
    kind: ExecutorNameSchema,
    code: EnvironmentLimitationCodeSchema,
    capability: v.nullable(EnvironmentCapabilitySchema),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

const CapabilityLimitInputSchema = v.strictObject({
    code: EnvironmentLimitationCodeSchema,
    capability: v.optional(EnvironmentCapabilitySchema),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * How a locked filtering environment approximates the reporter's exact configuration.
 */
export const FidelityLimitationCode = {
    /**
     * The executing product differs from the product named in the report.
     */
    ProductApproximation: 'product_approximation',

    /**
     * The executing controlled browser differs from the browser named in the report.
     */
    BrowserApproximation: 'browser_approximation',

    /**
     * The reported filter selection could not be reproduced exactly.
     */
    FilterSelectionApproximation: 'filter_selection_approximation',
} as const;

/**
 * Every FidelityLimitationCode value, for schemas and exhaustive listings.
 */
export const FIDELITY_LIMITATION_CODE_VALUES = Object.values(FidelityLimitationCode);

/**
 * FidelityLimitationCode value.
 */
export type FidelityLimitationCode =
    (typeof FidelityLimitationCode)[keyof typeof FidelityLimitationCode];

export const FidelityLimitationSchema = v.strictObject({
    code: v.picklist(FIDELITY_LIMITATION_CODE_VALUES),
    detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
});

/**
 * Stable reason a selection request was rejected outright.
 */
export const EnvironmentSelectionRejectionReason = {
    /**
     * The model's request failed schema validation.
     */
    InvalidEnvironmentSelection: 'invalid_environment_selection',

    /**
     * An environment was already locked by an earlier accepted request.
     */
    EnvironmentLocked: 'environment_locked',
} as const;

/**
 * Every EnvironmentSelectionRejectionReason value, for schemas and exhaustive listings.
 */
export const ENVIRONMENT_SELECTION_REJECTION_REASON_VALUES = Object.values(
    EnvironmentSelectionRejectionReason,
);

/**
 * EnvironmentSelectionRejectionReason value.
 */
export type EnvironmentSelectionRejectionReason =
    (typeof EnvironmentSelectionRejectionReason)[keyof typeof EnvironmentSelectionRejectionReason];

/**
 * Stable reason an observed-intent update was rejected.
 */
export const IntentUpdateRejectionReason = {
    /**
     * No environment has been locked yet, so there is nothing to update.
     */
    EnvironmentSelectionRequired: 'environment_selection_required',

    /**
     * The model's intent assessment failed schema validation.
     */
    InvalidIntentAssessment: 'invalid_intent_assessment',
} as const;

/**
 * Every IntentUpdateRejectionReason value, for schemas and exhaustive listings.
 */
export const INTENT_UPDATE_REJECTION_REASON_VALUES = Object.values(IntentUpdateRejectionReason);

/**
 * IntentUpdateRejectionReason value.
 */
export type IntentUpdateRejectionReason =
    (typeof IntentUpdateRejectionReason)[keyof typeof IntentUpdateRejectionReason];

export const RejectedEnvironmentSelectionSchema = v.strictObject({
    requestedKind: EnvironmentSelectionKindSchema,
    rationale: BoundedModelTextSchema,
    confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    rejectedAt: v.pipe(v.string(), v.isoTimestamp()),
    errorKind: v.literal(EnvironmentSelectionRejectionReason.EnvironmentLocked),
});

export const EnvironmentSelectionSnapshotSchema = v.pipe(
    v.strictObject({
        selectedKind: EnvironmentSelectionKindSchema,
        state: EnvironmentSelectionStateSchema,
        rationale: BoundedModelTextSchema,
        confidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
        requiredCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        advertisedCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        missingCapabilities: v.pipe(v.array(EnvironmentCapabilitySchema), v.maxLength(16)),
        descriptor: v.nullable(FilteringEnvironmentDescriptorSchema),
        lockedAt: v.pipe(v.string(), v.isoTimestamp()),
        declared: DeclaredIssueContextSchema,
        reported: ReportedExecutionContextSchema,
        observed: AgentIntentAssessmentSchema,
        intentHistory: v.pipe(v.array(AgentIntentAssessmentSchema), v.minLength(1), v.maxLength(4)),
        rejectedRequests: v.pipe(v.array(RejectedEnvironmentSelectionSchema), v.maxLength(4)),
        actual: v.nullable(ActualExecutionContextSchema),
        fidelityLimitations: v.pipe(v.array(FidelityLimitationSchema), v.maxLength(4)),
        capabilityLimits: v.pipe(v.array(CapabilityLimitSchema), v.maxLength(8)),
        filterBaseline: v.optional(v.nullable(ExecutableFilterDecisionSchema)),
        cliPreparation: v.optional(v.nullable(ExecutorPreparationSchema)),
    }),
    // The locked snapshot is correlated against its own descriptor rather than against any
    // particular executor name: the run's executor set is an input, so no executor kind may be
    // spelled here. Preparable executors carry the additional preparation correlations that
    // non-preparable executors must not.
    v.check((snapshot) => {
        if (snapshot.selectedKind === EnvironmentSelectionReservedCase.UnsupportedProductCase) {
            return (
                snapshot.state === EnvironmentSelectionState.Unsupported &&
                snapshot.descriptor === null &&
                snapshot.actual === null &&
                snapshot.filterBaseline == null
            );
        }
        if (
            snapshot.descriptor === null ||
            snapshot.descriptor.kind !== snapshot.selectedKind ||
            (snapshot.actual !== null && snapshot.actual.kind !== snapshot.selectedKind) ||
            !snapshot.capabilityLimits.every((limit) => limit.kind === snapshot.selectedKind)
        ) {
            return false;
        }
        if (snapshot.descriptor.preparationState !== EnvironmentPreparationState.Preparable) {
            return snapshot.cliPreparation == null;
        }
        if (snapshot.filterBaseline?.status === 'not_executable') {
            return (
                snapshot.state === EnvironmentSelectionState.CapabilityLimited &&
                snapshot.cliPreparation == null &&
                snapshot.actual === null
            );
        }
        if (snapshot.state === EnvironmentSelectionState.Preparing) {
            return snapshot.cliPreparation === null;
        }
        if (snapshot.cliPreparation?.state === ExecutorPreparationState.Limited) {
            return (
                snapshot.state === EnvironmentSelectionState.CapabilityLimited &&
                snapshot.actual === null
            );
        }
        if (snapshot.cliPreparation?.state === ExecutorPreparationState.Ready) {
            return (
                (snapshot.state === EnvironmentSelectionState.Ready ||
                    snapshot.state === EnvironmentSelectionState.CapabilityLimited) &&
                snapshot.actual !== null &&
                // The actual context is bound from the same prepared provenance, so the version
                // it claims must equal the provenance version byte for byte.
                snapshot.actual.productVersion === snapshot.cliPreparation.provenance.version
            );
        }
        return false;
    }, 'Selection provenance must remain bound to the locked environment.'),
    v.check(
        (snapshot) =>
            snapshot.state !== 'ready' || snapshot.filterBaseline?.status === 'executable',
        'A ready environment requires an executable official filter baseline.',
    ),
);

/**
 * EnvironmentCapability value.
 */
export type EnvironmentCapability =
    (typeof EnvironmentCapability)[keyof typeof EnvironmentCapability];

/**
 * Immutable host capability descriptor shown to the model.
 */
export type FilteringEnvironmentDescriptor = v.InferOutput<
    typeof FilteringEnvironmentDescriptorSchema
>;

/**
 * Agent-authored classification derived from issue and browser evidence.
 */
export type AgentIntentAssessment = v.InferOutput<typeof AgentIntentAssessmentSchema>;

/**
 * Typed model request that chooses one environment.
 */
export type AgentEnvironmentSelectionRequest = v.InferOutput<
    typeof AgentEnvironmentSelectionRequestSchema
>;

/**
 * Host-bound actual execution context for the locked filtering environment.
 */
export type ActualExecutionContextInput = v.InferOutput<typeof ActualExecutionContextInputSchema>;

/**
 * Host-authored capability limitation recorded after selection.
 */
export type CapabilityLimitInput = v.InferOutput<typeof CapabilityLimitInputSchema>;

/**
 * Durable audit snapshot of the one locked environment decision.
 */
export type EnvironmentSelectionSnapshot = v.InferOutput<typeof EnvironmentSelectionSnapshotSchema>;

/**
 * Accepted selection response returned to the model.
 */
export interface AcceptedEnvironmentSelectionResponse {
    /**
     * Indicates that this request locked the host.
     */
    accepted: true;

    /**
     * Environment kind locked by this request.
     */
    kind: EnvironmentSelectionKind;

    /**
     * Indicates that later selection requests will be rejected.
     */
    locked: true;

    /**
     * Readiness state derived from immutable host capability data.
     */
    state: EnvironmentSelectionSnapshot['state'];

    /**
     * Stable host limitation code, when the choice cannot execute.
     */
    limitationCode: EnvironmentLimitationCode | null;

    /**
     * Official identities the reported selection resolved to, or the finite reason it resolved to
     * none. Null only for an unsupported product case, which reproduces no filtering at all.
     */
    filterBaseline: ExecutableFilterDecision | null;
}

/**
 * Rejected selection response returned for invalid input or a locked host.
 */
export interface RejectedEnvironmentSelectionResponse {
    /**
     * Indicates that the request did not change the locked selection.
     */
    accepted: false;

    /**
     * Stable reason for rejecting the request.
     */
    errorKind: EnvironmentSelectionRejectionReason;

    /**
     * Existing locked environment when one has already been chosen.
     */
    selectedKind?: EnvironmentSelectionKind;

    /**
     * Bounded validation explanation for malformed model input.
     */
    error?: string;
}

/**
 * Public response from the model-facing environment selection boundary.
 */
export type EnvironmentSelectionResponse =
    | AcceptedEnvironmentSelectionResponse
    | RejectedEnvironmentSelectionResponse;

/**
 * Response from the observed-intent refinement boundary.
 */
export interface IntentUpdateResponse {
    /**
     * Whether the assessment replaced the current observed intent.
     */
    accepted: boolean;

    /**
     * Locked environment retained by the update.
     */
    selectedKind?: EnvironmentSelectionKind;

    /**
     * Stable rejection reason when selection or input is missing.
     */
    errorKind?: IntentUpdateRejectionReason;

    /**
     * Bounded validation detail for invalid model input.
     */
    error?: string;
}

/**
 * Deterministic dependencies for the selection host.
 */
export interface EnvironmentSelectionHostOptions {
    /**
     * Clock used for lock and rejected-request audit timestamps.
     */
    now?: () => string;
}

/**
 * Rationale recorded when the host locks the run's sole executor without a model turn.
 */
const SOLE_EXECUTOR_RATIONALE = 'Sole executor available for this run';

/**
 * Observed-intent rationale recorded alongside the deterministic sole-executor lock.
 */
const SOLE_EXECUTOR_INTENT_RATIONALE = 'No executor choice was offered for this run.';

/**
 * Detail recorded when a descriptor ships its adapter as unavailable.
 */
const UNAVAILABLE_EXECUTOR_DETAIL = 'The executor adapter is not available in this delivery slice.';

/**
 * Truncate one host-owned context value to its durable schema bound.
 *
 * @param value - Optional issue-derived context value.
 * @returns Trimmed bounded text or null when no text remains.
 */
function boundedContext(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, 200) : null;
}

/**
 * Format a bounded Valibot failure without retaining arbitrary input values.
 *
 * @param issues - Validation issues returned by Valibot.
 * @returns Stable bounded field-path summary.
 */
function validationDetail(issues: readonly v.BaseIssue<unknown>[]): string {
    const paths = issues
        .map((issue) => issue.path?.map((item) => String(item.key)).join('.'))
        .filter((path): path is string => Boolean(path));
    return `Invalid fields: ${[...new Set(paths)].slice(0, 8).join(', ') || 'request'}`;
}

/**
 * Explain why a reported filter selection yields no executable official baseline.
 *
 * The sentence carries no reporter text: the bounded reporter echo already lives in the durable
 * `filterBaseline` field, and this detail is only the finite classification of the failure.
 *
 * @param code - The finite reason the reported filter selection resolved to no official baseline.
 * @returns One fixed host-authored sentence for the recorded capability limit.
 */
function filterBaselineLimitDetail(code: NonExecutableFilterCode): string {
    if (code === NonExecutableFilterCode.FilterSelectionMissing) {
        return 'The report names no filter selection, and no default filter baseline is invented.';
    }
    if (code === NonExecutableFilterCode.FilterNormalizationFailed) {
        return 'A reported filter name matched no official AdGuard filter and was not omitted.';
    }
    return 'Only third-party or custom filter sources were reported, which this run never executes.';
}

/**
 * Clone and validate a durable snapshot so callers cannot mutate host state by reference.
 *
 * @param snapshot - Internal snapshot to expose.
 * @returns Independent schema-validated snapshot.
 */
function cloneSnapshot(snapshot: EnvironmentSelectionSnapshot): EnvironmentSelectionSnapshot {
    return v.parse(EnvironmentSelectionSnapshotSchema, structuredClone(snapshot));
}

/**
 * Own the agent's first environment choice and all provenance attached to that immutable lock.
 */
export class EnvironmentSelectionHost {
    /**
     * Immutable host-owned capability descriptors indexed by executor name.
     */
    private readonly descriptors: Map<ExecutorName, FilteringEnvironmentDescriptor>;

    /**
     * Clock used for durable audit timestamps.
     */
    private readonly now: () => string;

    /**
     * Host-owned declared issue signals.
     */
    private readonly declared: EnvironmentSelectionSnapshot['declared'];

    /**
     * Host-owned reported product and browser context.
     */
    private readonly reported: EnvironmentSelectionSnapshot['reported'];

    /**
     * Offline verdict on whether the reported filter selection has an executable official baseline.
     */
    private readonly filterBaseline: ExecutableFilterDecision;

    /**
     * The first accepted selection, mutated only through bounded host methods.
     */
    private selected: EnvironmentSelectionSnapshot | null = null;

    /**
     * Approximations reported by the executing route, retained across fidelity recomputation.
     */
    private readonly routeFidelityLimitations: EnvironmentSelectionSnapshot['fidelityLimitations'] =
        [];

    /**
     * Create one undecided host from immutable issue facts and the run's capability descriptors.
     *
     * @param facts - Parser-owned issue facts used only as evidence and reported context.
     * @param descriptors - Host-owned descriptors for the run's executor set. At least one is
     *   required and every kind must name a different executor.
     * @param options - Deterministic clock seam for tests.
     */
    constructor(
        facts: IssueFacts,
        descriptors: readonly FilteringEnvironmentDescriptor[],
        options: EnvironmentSelectionHostOptions = {},
    ) {
        const parsedDescriptors = v.parse(v.array(FilteringEnvironmentDescriptorSchema), [
            ...descriptors,
        ]);
        if (parsedDescriptors.length === 0) {
            throw new Error('At least one filtering environment descriptor is required.');
        }
        this.descriptors = new Map(
            parsedDescriptors.map((descriptor) => [descriptor.kind, descriptor]),
        );
        if (this.descriptors.size !== parsedDescriptors.length) {
            const seen = new Set<ExecutorName>();
            const duplicate = parsedDescriptors.find(
                (descriptor) => seen.has(descriptor.kind) || (seen.add(descriptor.kind), false),
            );
            throw new Error(`Duplicate executor descriptor for "${duplicate?.kind}".`);
        }
        this.now = options.now ?? (() => new Date().toISOString());
        this.declared = v.parse(DeclaredIssueContextSchema, {
            issueFormType: facts.declaredIssueType ?? null,
            typeLabels: facts.labels
                .filter((label) => /^T:\s*/iu.test(label))
                .slice(0, 20)
                .map((label) => label.slice(0, 200)),
        });
        this.reported = v.parse(ReportedExecutionContextSchema, {
            product: boundedContext(facts.product),
            os: boundedContext(facts.os),
            browser: boundedContext(facts.browser),
        });
        this.filterBaseline = decideExecutableFilters(facts.enabledFilters);
    }

    /**
     * Return fresh copies of the host-owned descriptors advertised to the agent.
     *
     * @returns Schema-validated descriptors with no runtime secrets or model-authored fields.
     */
    capabilities(): FilteringEnvironmentDescriptor[] {
        return v.parse(v.array(FilteringEnvironmentDescriptorSchema), [
            ...this.descriptors.values(),
        ]);
    }

    /**
     * Return the executor names the run's descriptor set advertises.
     *
     * @returns Registration-order executor names, fresh copies of the host-owned set.
     */
    advertisedExecutorNames(): ExecutorName[] {
        return [...this.descriptors.keys()];
    }

    /**
     * Lock the first valid model selection and reject every later request without fallback.
     *
     * @param request - Untrusted model tool arguments.
     * @returns Accepted lock metadata or a stable rejection.
     */
    select(request: unknown): EnvironmentSelectionResponse {
        const parsed = v.safeParse(AgentEnvironmentSelectionRequestSchema, request);
        if (!parsed.success) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error: validationDetail(parsed.issues),
            };
        }
        if (this.selected) {
            if (this.selected.rejectedRequests.length < 4) {
                this.selected.rejectedRequests.push({
                    requestedKind: parsed.output.kind,
                    rationale: parsed.output.rationale,
                    confidence: parsed.output.confidence,
                    rejectedAt: this.now(),
                    errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                });
                this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
            }
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                selectedKind: this.selected.selectedKind,
            };
        }
        if (
            parsed.output.kind !== EnvironmentSelectionReservedCase.UnsupportedProductCase &&
            !this.descriptors.has(parsed.output.kind)
        ) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error:
                    `Unknown executor "${parsed.output.kind}". Advertised executors: ` +
                    `${[...this.descriptors.keys()].join(', ')}.`,
            };
        }
        return this.lock(parsed.output);
    }

    /**
     * Lock the run's sole executor without a model turn.
     *
     * Used when the run's executor set has exactly one member: there is nothing to choose, so the
     * host locks the executor deterministically with the same snapshot shape a model selection
     * would produce.
     *
     * @param name - Executor name that must be one of the advertised descriptors.
     * @returns Accepted lock metadata or a stable rejection naming the advertised set.
     */
    lockSoleExecutor(name: ExecutorName): EnvironmentSelectionResponse {
        const descriptor = this.descriptors.get(name);
        if (!descriptor) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.InvalidEnvironmentSelection,
                error:
                    `Unknown executor "${name}". Advertised executors: ` +
                    `${[...this.descriptors.keys()].join(', ')}.`,
            };
        }
        if (this.selected) {
            return {
                accepted: false,
                errorKind: EnvironmentSelectionRejectionReason.EnvironmentLocked,
                selectedKind: this.selected.selectedKind,
            };
        }
        return this.lock({
            kind: name,
            requiredCapabilities: [],
            intent: {
                issueType: 'unknown',
                rationale: SOLE_EXECUTOR_INTENT_RATIONALE,
                confidence: 1,
                evidence: [],
                conflicts: [],
            },
            rationale: SOLE_EXECUTOR_RATIONALE,
            confidence: 1,
        });
    }

    /**
     * Build the immutable lock for one accepted request.
     *
     * Every accepted path — the model selection and the deterministic sole-executor lock — flows
     * through here, so both produce byte-identical snapshot shapes.
     *
     * @param request - Validated selection request naming the resolver's executor set.
     * @returns Accepted lock metadata for the named executor or the reserved case.
     */
    private lock(request: AgentEnvironmentSelectionRequest): EnvironmentSelectionResponse {
        const descriptor =
            request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ? null
                : (this.descriptors.get(request.kind) ?? null);
        const advertisedCapabilities = descriptor ? [...descriptor.capabilities] : [];
        const missingCapabilities = request.requiredCapabilities.filter(
            (capability) => !advertisedCapabilities.includes(capability),
        );
        const capabilityLimits: EnvironmentSelectionSnapshot['capabilityLimits'] = [];
        let state: EnvironmentSelectionSnapshot['state'];
        let limitationCode: EnvironmentLimitationCode | null = null;
        if (request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase) {
            state = EnvironmentSelectionState.Unsupported;
        } else if (descriptor?.preparationState === EnvironmentPreparationState.Preparable) {
            state = EnvironmentSelectionState.Preparing;
        } else if (descriptor?.availability === FilteringEnvironmentAvailability.Unavailable) {
            state = EnvironmentSelectionState.CapabilityLimited;
            // Fresh descriptors write enum members; the widened code schema exists only so the
            // persisted run-result read-back keeps parsing renamed historical codes.
            limitationCode = descriptor.limitationCode as EnvironmentLimitationCode;
            capabilityLimits.push({
                kind: request.kind,
                code: descriptor.limitationCode ?? EnvironmentLimitationCode.ExecutorUnavailable,
                capability: null,
                detail: UNAVAILABLE_EXECUTOR_DETAIL,
            });
        } else if (missingCapabilities.length > 0) {
            state = EnvironmentSelectionState.CapabilityLimited;
            limitationCode = EnvironmentLimitationCode.RequiredCapabilityUnavailable;
            // Deduped like the snapshot's own capability lists below, so a model that repeats one
            // unadvertised capability still fits the bounded limit list instead of throwing.
            for (const capability of new Set(missingCapabilities)) {
                capabilityLimits.push({
                    kind: request.kind,
                    code: EnvironmentLimitationCode.RequiredCapabilityUnavailable,
                    capability,
                    detail: 'The locked environment does not advertise a required capability.',
                });
            }
        } else {
            state = EnvironmentSelectionState.Ready;
        }

        const filterBaseline =
            request.kind === EnvironmentSelectionReservedCase.UnsupportedProductCase
                ? null
                : this.filterBaseline;
        if (filterBaseline?.status === 'not_executable') {
            state = EnvironmentSelectionState.CapabilityLimited;
            limitationCode = EnvironmentLimitationCode.FilterSelectionNotExecutable;
            capabilityLimits.push({
                kind: request.kind,
                code: EnvironmentLimitationCode.FilterSelectionNotExecutable,
                capability: EnvironmentCapability.BaselineIntegrity,
                detail: filterBaselineLimitDetail(filterBaseline.code),
            });
        }

        const fidelityLimitations: EnvironmentSelectionSnapshot['fidelityLimitations'] = [];
        // An executor that does not browse the reported page itself can only approximate the
        // reported product's own filtering; the extension descriptor browses, so it never
        // records this approximation.
        if (
            descriptor !== null &&
            !descriptor.capabilities.includes(EnvironmentCapability.BrowserNavigation) &&
            this.reported.product !== null
        ) {
            fidelityLimitations.push({
                code: FidelityLimitationCode.ProductApproximation,
                detail: 'The selected executor approximates the reported desktop filtering behavior.',
            });
        }
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, {
            selectedKind: request.kind,
            state,
            rationale: request.rationale,
            confidence: request.confidence,
            requiredCapabilities: [...new Set(request.requiredCapabilities)],
            advertisedCapabilities,
            missingCapabilities: [...new Set(missingCapabilities)],
            descriptor,
            lockedAt: this.now(),
            declared: this.declared,
            reported: this.reported,
            observed: request.intent,
            intentHistory: [request.intent],
            rejectedRequests: [],
            actual: null,
            fidelityLimitations,
            capabilityLimits,
            filterBaseline,
            cliPreparation: null,
        });
        return {
            accepted: true,
            kind: this.selected.selectedKind,
            locked: true,
            state: this.selected.state,
            limitationCode,
            filterBaseline: this.selected.filterBaseline ?? null,
        };
    }

    /**
     * Bind one prepared executor's durable preparation result to the locked preparable selection.
     *
     * @param outcome - Ready path-free provenance, or a stable stage-bound limitation.
     */
    attachExecutorPreparation(outcome: ExecutorPreparationOutcome): void {
        if (
            !this.selected ||
            this.selected.descriptor === null ||
            this.selected.descriptor.preparationState !== EnvironmentPreparationState.Preparable
        ) {
            throw new Error(
                'Executor preparation requires a locked preparable environment selection.',
            );
        }
        if (this.selected.cliPreparation != null) {
            throw new Error('Executor preparation is already bound to this environment selection.');
        }
        const parsed = v.parse(ExecutorPreparationOutcomeSchema, structuredClone(outcome));
        if (parsed.ready) {
            const provenance = v.parse(
                ExecutorPreparedProvenanceSchema,
                structuredClone(parsed.provenance),
            );
            this.selected.cliPreparation = { state: ExecutorPreparationState.Ready, provenance };
            this.selected.actual = {
                kind: this.selected.selectedKind,
                product: provenance.product,
                browser: BrowserDisplayName.CloakBrowserChromium,
                productVersion: provenance.version,
            };
            if (this.selected.missingCapabilities.length === 0) {
                this.selected.state = EnvironmentSelectionState.Ready;
            } else {
                this.selected.state = EnvironmentSelectionState.CapabilityLimited;
                for (const capability of this.selected.missingCapabilities) {
                    if (this.selected.capabilityLimits.length >= 8) {
                        break;
                    }
                    this.selected.capabilityLimits.push({
                        kind: this.selected.selectedKind,
                        code: EnvironmentLimitationCode.RequiredCapabilityUnavailable,
                        capability,
                        detail: 'The prepared executor does not advertise a required capability.',
                    });
                }
            }
            this.refreshFidelityLimitations();
        } else {
            this.selected.cliPreparation = {
                state: ExecutorPreparationState.Limited,
                limitation: parsed.limitation,
            };
            this.selected.state = EnvironmentSelectionState.CapabilityLimited;
            this.selected.capabilityLimits.push({
                kind: this.selected.selectedKind,
                code: EnvironmentLimitationCode.EnvironmentPreparationFailed,
                capability: EnvironmentCapability.CliInstallation,
                detail: 'Executor preparation did not become ready.',
            });
        }
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Replace only the model-owned observed intent after new evidence is collected.
     *
     * @param assessment - Untrusted model-authored classification update.
     * @returns Update result that retains the original locked environment.
     */
    updateObservedIntent(assessment: unknown): IntentUpdateResponse {
        if (!this.selected) {
            return {
                accepted: false,
                errorKind: IntentUpdateRejectionReason.EnvironmentSelectionRequired,
            };
        }
        const parsed = v.safeParse(AgentIntentAssessmentSchema, assessment);
        if (!parsed.success) {
            return {
                accepted: false,
                selectedKind: this.selected.selectedKind,
                errorKind: IntentUpdateRejectionReason.InvalidIntentAssessment,
                error: validationDetail(parsed.issues),
            };
        }
        const history = this.selected.intentHistory;
        this.selected.observed = parsed.output;
        this.selected.intentHistory =
            history.length < 4
                ? [...history, parsed.output]
                : [history[0], ...history.slice(-2), parsed.output];
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
        return { accepted: true, selectedKind: this.selected.selectedKind };
    }

    /**
     * Replace the actual execution context with what the run really executed.
     *
     * A prepared CLI route binds a context from its own provenance because that is normally what
     * filters. An executor that measures its engine differently than the product CLI makes that
     * assumption wrong: the engine, not the product CLI, does the filtering, and it says so with a
     * different version. The report must name the thing that ran, so the executing adapter is
     * allowed to correct the earlier assumption — once, and only for the locked environment.
     *
     * @param kind - Locked environment the context belongs to.
     * @param context - Adapter-owned actual product and browser values.
     */
    rebindActualContext(kind: ExecutorName, context: ActualExecutionContextInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Actual context must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        this.selected.actual = null;
        this.bindActualContext(kind, context);
    }

    /**
     * Bind the adapter-reported execution context to the locked environment.
     *
     * @param kind - Locked environment the context belongs to.
     * @param context - Adapter-owned actual product and browser values.
     */
    bindActualContext(kind: ExecutorName, context: ActualExecutionContextInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Actual context must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        const parsed = v.parse(ActualExecutionContextInputSchema, context);
        const actual = {
            kind,
            product: parsed.product,
            browser: parsed.browser,
            productVersion: parsed.productVersion ?? null,
        };
        if (this.selected.actual !== null) {
            if (JSON.stringify(this.selected.actual) !== JSON.stringify(actual)) {
                throw new Error('Actual execution context is already bound to different values.');
            }
            return;
        }
        this.selected.actual = actual;
        this.refreshFidelityLimitations();
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Mark the proxied CLI evidence route ready and grant the capabilities it executes.
     *
     * This is the live-run counterpart of a canary `route_result`: that receipt proves filtering
     * through the fixed ID-2 canary matrix, which a live investigation never runs. Here the proof
     * is the run's own: a confirmed activation, a filtering foreground the Host started, and an
     * interception probe showing the proxy presenting this run's authority. Both paths grant the
     * same capabilities because both end with the CLI actually filtering the controlled browser.
     *
     * @param kind - Locked environment the route belongs to.
     */
    attachCliEvidenceRouteReady(kind: ExecutorName): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Evidence route must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        if (this.selected.state === EnvironmentSelectionState.Unsupported) {
            return;
        }
        this.selected.state = EnvironmentSelectionState.Ready;
        this.selected.advertisedCapabilities = [
            ...new Set([
                ...this.selected.advertisedCapabilities,
                EnvironmentCapability.BrowserNavigation,
                EnvironmentCapability.FilteringControl,
                EnvironmentCapability.CliFiltering,
                EnvironmentCapability.BaselineIntegrity,
                EnvironmentCapability.PhaseProof,
                EnvironmentCapability.CandidateApplication,
            ]),
        ];
        this.selected.missingCapabilities = this.selected.requiredCapabilities.filter(
            (capability) => !this.selected!.advertisedCapabilities.includes(capability),
        );
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Record how closely the executed run reproduced the reporter's own filter selection.
     *
     * Unlike a capability limit this never degrades the locked state: browsing with a filter the
     * catalog could not offer is weaker evidence, not a missing capability, and the terminal
     * decision stays available with the gap stated in the report.
     *
     * @param kind - Locked environment the approximation belongs to.
     * @param detail - Bounded human-readable description of the difference.
     */
    recordFilterSelectionApproximation(kind: ExecutorName, detail: string): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Filter approximation must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        if (this.routeFidelityLimitations.length > 0) {
            return;
        }
        this.routeFidelityLimitations.push(
            v.parse(FidelityLimitationSchema, {
                code: FidelityLimitationCode.FilterSelectionApproximation,
                detail,
            }),
        );
        this.refreshFidelityLimitations();
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Record one capability limit against the locked environment.
     *
     * @param kind - Locked environment the limit belongs to.
     * @param limitation - Capability the route could not honor.
     */
    recordCapabilityLimitation(kind: ExecutorName, limitation: CapabilityLimitInput): void {
        if (!this.selected || this.selected.selectedKind !== kind) {
            throw new Error(
                `Capability limit must name the locked environment ${String(this.selected?.selectedKind)}.`,
            );
        }
        const parsed = v.parse(CapabilityLimitInputSchema, limitation);
        if (this.selected.capabilityLimits.length < 8) {
            this.selected.capabilityLimits.push({
                kind,
                code: parsed.code,
                capability: parsed.capability ?? null,
                detail: parsed.detail,
            });
        }
        this.selected.state = EnvironmentSelectionState.CapabilityLimited;
        this.selected = v.parse(EnvironmentSelectionSnapshotSchema, this.selected);
    }

    /**
     * Return an independent durable snapshot of the current lock.
     *
     * @returns Schema-validated selection snapshot or null before the first accepted choice.
     */
    snapshot(): EnvironmentSelectionSnapshot | null {
        return this.selected ? cloneSnapshot(this.selected) : null;
    }

    /**
     * Recompute product and browser approximation notes from reported and actual host context.
     */
    private refreshFidelityLimitations(): void {
        if (!this.selected?.actual) {
            return;
        }
        // Route-reported approximations survive this recomputation: they describe what the run
        // actually executed, which the reported-versus-actual comparison below cannot re-derive.
        const limitations: EnvironmentSelectionSnapshot['fidelityLimitations'] = [
            ...this.routeFidelityLimitations,
        ];
        if (
            this.reported.product !== null &&
            this.reported.product.toLowerCase() !== this.selected.actual.product.toLowerCase()
        ) {
            limitations.push({
                code: FidelityLimitationCode.ProductApproximation,
                detail: 'The actual filtering product differs from the product named in the report.',
            });
        }
        if (
            this.reported.browser !== null &&
            this.reported.browser.toLowerCase() !== this.selected.actual.browser.toLowerCase()
        ) {
            limitations.push({
                code: FidelityLimitationCode.BrowserApproximation,
                detail: 'The actual controlled browser differs from the browser named in the report.',
            });
        }
        this.selected.fidelityLimitations = limitations;
    }
}

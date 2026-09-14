import type { BrowserPreflightEvidence } from '../analyzer/browser-first-run';
import { inspectFullPageVisualCapture } from '../analyzer/full-page-capture-inspection';
import { probeAnnoyanceSurfaces } from '../browser/annoyance-probe';
import type { IBrowserSession } from '../browser/browser-interfaces';
import { createBrowserToolHandlers, type BrowserToolHandlers } from '../browser/browser-tools';
import {
    persistSafeInteractionRecord,
    runSafeInteractionSequence,
} from '../browser/safe-interaction-runner';
import type { SingleShotClient } from '../pi/single-shot-types';
import type { TraceRecorder } from '../tracer/trace-recorder';
import { ReporterSymptomPresence } from '../types/reporter-symptom-presence';
import type { ReproProfile } from '../types/repro-profile';
import type { AdsBaselinePhaseObservation } from '../validator/ads-baseline-reproduction';
import type { AdsCandidatePhaseObservation } from '../validator/ads-candidate-verification';
import type { AdsEnvironmentPhaseObservationInput } from '../validator/phase-orchestrator';
import {
    assessInteractedPageUsability,
    correlateAnnoyanceTarget,
    selectAnnoyanceTarget,
    type AnnoyanceSurfaceScan,
    type AnnoyanceTarget,
    type InteractedPageUsability,
} from './annoyance-target';
import {
    EnvironmentAdapterLimitationCode,
    EnvironmentLimitationStage,
    type EnvironmentArtifactReference,
    type EnvironmentBrowserCapture,
    type ValidatorPhaseCompletion,
} from './filtering-environment';
import type { EnvironmentPhase } from './environment-proofs';
import {
    summarizeSafeInteractionRecord,
    type NormalizedSafeInteractionPlan,
    type SafeInteractionRecord,
    type SafeInteractionSummary,
} from './safe-interaction';
import { PhaseLabel } from '../types/validation';
import { BrowserFallbackReason } from '../types/browser-fallback-reason';

/**
 * Bounded seams around the browser, the interaction, the scan, and vision.
 *
 * Fixtures replace them; production uses the defaults and keeps the real observer.
 */
export interface AnnoyanceObserverDependencies {
    /**
     * Build the browser tool handlers for one phase session.
     */
    createHandlers?: (session: IBrowserSession) => BrowserToolHandlers;

    /**
     * Execute the normalized interaction sequence for one phase.
     */
    runInteraction?: (
        config: Parameters<typeof runSafeInteractionSequence>[0],
    ) => ReturnType<typeof runSafeInteractionSequence>;

    /**
     * Scan the interacted page for obstructing surfaces.
     */
    probeSurfaces?: (session: IBrowserSession) => ReturnType<typeof probeAnnoyanceSurfaces>;

    /**
     * Inspect one captured page through structured vision batches.
     */
    inspectVisualCapture?: (
        options: Parameters<typeof inspectFullPageVisualCapture>[0],
        capture: Parameters<typeof inspectFullPageVisualCapture>[1],
    ) => ReturnType<typeof inspectFullPageVisualCapture>;
}

/**
 * Everything one Annoyance investigation's phase observations need.
 */
export interface AnnoyanceObserverOptions {
    /**
     * Exact normalized plan every phase executes; its digest is the preparation digest.
     */
    plan: NormalizedSafeInteractionPlan;

    /**
     * Reported issue URL every phase navigates to.
     */
    targetUrl: string;

    /**
     * Canonical origin the interaction may not leave.
     */
    allowedOrigin: string;

    /**
     * Reporter-authored description of the annoyance, handed to vision unchanged.
     */
    reporterSymptom: string;

    /**
     * Reproduction profile recorded with every phase completion.
     */
    profile: ReproProfile;

    /**
     * Authoritative trace artifact registry.
     */
    recorder: TraceRecorder;

    /**
     * Run-owned artifacts directory.
     */
    artifactsDir: string;

    /**
     * Exact Host-configured secrets redacted before retention.
     */
    configuredSecrets: readonly string[];

    /**
     * Single-shot client used only to convert screenshot pixels into textual observations.
     */
    vision: SingleShotClient;

    /**
     * Deterministic seams for tests; production uses the defaults.
     */
    dependencies?: AnnoyanceObserverDependencies;
}

/**
 * Optional interaction summary a phase observation carries.
 */
interface ObservedInteractionField {
    /**
     * Summary of the bounded sequence the phase performed, absent when it performed none.
     */
    interaction?: SafeInteractionSummary;
}

/**
 * Complete material one observed phase produced.
 */
interface ObservedAnnoyancePhase {
    /**
     * Complete validator-owned observation handed to the recorder unchanged.
     */
    completion: ValidatorPhaseCompletion;

    /**
     * Raw navigation, status, text and artifact facts for this phase.
     */
    access: BrowserPreflightEvidence;

    /**
     * Ordered interaction evidence, or null when the page was never reached.
     */
    record: SafeInteractionRecord | null;
}

/**
 * Read one bounded string from a browser tool result.
 *
 * @param value - Raw handler field.
 * @param fallback - Value used when the handler reported nothing usable.
 * @returns Handler-reported string, else the fallback.
 */
function toolString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Read one finite number from a browser tool result.
 *
 * @param value - Raw handler field.
 * @param fallback - Value used when the handler reported nothing usable.
 * @returns Handler-reported number, else the fallback.
 */
function toolNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Common role of one canonical environment evidence artifact.
 *
 * Mirrors the inline picklist backing `EnvironmentArtifactReference['kind']` in
 * `filtering-environment.ts`; kept local here because that module does not export a named set.
 */
const EnvironmentArtifactKind = {
    /**
     * A rendered page screenshot (viewport, full-page overview, or tile).
     */
    Screenshot: 'screenshot',

    /**
     * A captured HAR network archive.
     */
    Har: 'har',

    /**
     * A captured DOM snapshot.
     */
    Dom: 'dom',

    /**
     * A vision-model visual inventory result.
     */
    Vision: 'vision',

    /**
     * A factual validation result.
     */
    Validation: 'validation',

    /**
     * A recorded safe-interaction sequence.
     */
    Interaction: 'interaction',
} as const;

/**
 * Resolve one unique trace artifact into the common environment vocabulary.
 *
 * @param recorder - Authoritative trace artifact registry.
 * @param artifactId - Exact artifact identity to resolve.
 * @param kind - Common artifact role.
 * @returns Canonical common artifact reference.
 */
function environmentArtifact(
    recorder: TraceRecorder,
    artifactId: string,
    kind: EnvironmentArtifactReference['kind'],
): EnvironmentArtifactReference {
    const matches = recorder.getArtifacts().filter((artifact) => artifact.id === artifactId);
    if (matches.length !== 1) {
        throw new Error(`Environment artifact is missing or ambiguous: ${artifactId}`);
    }
    return { artifactId, kind, path: matches[0]!.path };
}

/**
 * Read the ordered tile identities one screenshot capture produced.
 *
 * @param tileCoverage - Raw tile coverage reported by the screenshot handler.
 * @returns Ordered tile artifact identities.
 */
function tileArtifactIds(tileCoverage: unknown): string[] {
    if (!tileCoverage || typeof tileCoverage !== 'object') {
        return [];
    }
    const tiles = (tileCoverage as Record<string, unknown>).tiles;
    if (!Array.isArray(tiles)) {
        return [];
    }
    return tiles
        .map((tile) =>
            tile && typeof tile === 'object'
                ? (tile as Record<string, unknown>).artifactId
                : undefined,
        )
        .filter((artifactId): artifactId is string => typeof artifactId === 'string');
}

/**
 * Observe the A, B, and C phases of one interactive Annoyance investigation.
 *
 * One observer holds one normalized plan and reports its digest for every phase, so the baseline
 * and the candidate cannot disagree about what preparation the run performed.
 */
export class AnnoyanceInteractionObserver {
    /**
     * Interaction summary each observed phase produced.
     */
    private readonly interactions = new Map<EnvironmentPhase, SafeInteractionSummary>();

    /**
     * Ordered interaction evidence the published-baseline phase produced.
     */
    private baselineRecord: SafeInteractionRecord | null = null;

    /**
     * Obstruction scan the published-baseline phase produced.
     */
    private baselineScan: AnnoyanceSurfaceScan | null = null;

    /**
     * Annoyance identity the published-baseline phase recorded.
     */
    private annoyanceTarget: AnnoyanceTarget | null = null;

    /**
     * Presence of that identity in the candidate phase.
     */
    private candidateCorrelation: ReporterSymptomPresence | null = null;

    /**
     * Usability of the interacted page under the candidate.
     */
    private candidateUsability: InteractedPageUsability | null = null;

    /**
     * Create one observer for a single interactive Annoyance investigation.
     *
     * @param options - Plan, target, artifact sink, and vision inputs shared by every phase.
     */
    constructor(private readonly options: AnnoyanceObserverOptions) {}

    /**
     * Observe one filtering-disabled or published-baseline phase.
     *
     * @param input - Common session plus exact adapter phase proof.
     * @returns Validator outcome, page-access facts, preparation digest, interaction summary.
     */
    async observeBaseline(
        input: AdsEnvironmentPhaseObservationInput,
    ): Promise<AdsBaselinePhaseObservation> {
        const observed = await this.observePhase(input);
        return {
            completion: observed.completion,
            access: observed.access,
            preparationDigest: this.options.plan.digest,
            ...this.interactionField(input.phase),
        };
    }

    /**
     * Observe the candidate phase by replaying the same normalized sequence.
     *
     * @param input - Common session plus exact adapter phase proof.
     * @returns Validator outcome, preparation digest, and interaction summary.
     */
    async observeCandidate(
        input: AdsEnvironmentPhaseObservationInput,
    ): Promise<AdsCandidatePhaseObservation> {
        const observed = await this.observePhase(input);
        return {
            completion: observed.completion,
            preparationDigest: this.options.plan.digest,
            ...this.interactionField(input.phase),
        };
    }

    /**
     * Read the annoyance identity the published-baseline phase recorded.
     *
     * @returns Annoyance identity recorded by the published-baseline phase, else null.
     */
    target(): AnnoyanceTarget | null {
        return this.annoyanceTarget;
    }

    /**
     * Read the presence of that identity in the candidate phase.
     *
     * @returns Presence of that identity in the candidate phase, else null.
     */
    correlation(): ReporterSymptomPresence | null {
        return this.candidateCorrelation;
    }

    /**
     * Read the interacted-page usability the candidate phase decided.
     *
     * @returns Interacted-page usability decided by the candidate phase, else null.
     */
    usability(): InteractedPageUsability | null {
        return this.candidateUsability;
    }

    /**
     * Read one phase's interaction summary.
     *
     * @param phase - Phase label.
     * @returns That phase's interaction summary, else null.
     */
    interactionOf(phase: EnvironmentPhase): SafeInteractionSummary | null {
        return this.interactions.get(phase) ?? null;
    }

    /**
     * Project one phase's interaction summary into the optional observation field.
     *
     * @param phase - Phase label.
     * @returns The interaction field, or nothing when the phase performed no sequence.
     */
    private interactionField(phase: EnvironmentPhase): ObservedInteractionField {
        const interaction = this.interactions.get(phase);
        return interaction ? { interaction } : {};
    }

    /**
     * Navigate, drive the normalized sequence, scan the result, capture it, and describe it.
     *
     * @param input - Common session plus exact adapter phase proof.
     * @returns Complete material for this phase.
     */
    private async observePhase(
        input: AdsEnvironmentPhaseObservationInput,
    ): Promise<ObservedAnnoyancePhase> {
        const options = this.options;
        const dependencies = options.dependencies;
        const handlers = dependencies?.createHandlers
            ? dependencies.createHandlers(input.session)
            : createBrowserToolHandlers({
                  session: input.session,
                  recorder: options.recorder,
                  artifactsDir: options.artifactsDir,
                  allowedOrigin: options.targetUrl,
                  consentStrategy: options.profile.consentStrategy,
              });

        const opened = await handlers.open_page({ url: options.targetUrl });
        if (opened.error) {
            return this.navigationFailure(input, opened);
        }

        const record = await (dependencies?.runInteraction ?? runSafeInteractionSequence)({
            session: input.session,
            plan: options.plan,
            allowedOrigin: options.allowedOrigin,
        });
        this.interactions.set(input.phase, summarizeSafeInteractionRecord(record));
        const interactionArtifact = persistSafeInteractionRecord({
            record,
            baseline: input.phase === PhaseLabel.C ? this.baselineRecord : null,
            configuredSecrets: options.configuredSecrets,
            artifactsDir: options.artifactsDir,
            recorder: options.recorder,
            artifactIdSuffix: input.phaseTokenId,
        });

        // The scan runs after the sequence and before the capture: a scan taken any earlier would
        // record a page on which the reported annoyance does not exist yet.
        const scan = await (dependencies?.probeSurfaces ?? probeAnnoyanceSurfaces)(input.session);

        const captured = await handlers.screenshot({ captureTiles: true });
        const dom = await handlers.get_dom({});
        const network = await handlers.get_network_log({});
        const viewportArtifactId = captured.artifactId;
        const fullPageArtifactId = captured.fullPageArtifactId;
        if (typeof viewportArtifactId !== 'string' || typeof fullPageArtifactId !== 'string') {
            throw new Error('The Annoyance phase captured no complete page evidence.');
        }
        const domArtifactId = String(dom.artifactId);
        const harArtifactId = String(network.artifactId);
        const access: BrowserPreflightEvidence = {
            statusCode: toolNumber(opened.statusCode, 200),
            title: toolString(opened.title, ''),
            htmlLength: toolNumber(dom.htmlLength, 0),
            visibleTextPreview: toolString(dom.visibleTextPreview, ''),
            screenshotArtifactId: viewportArtifactId,
            domArtifactId,
            harArtifactId,
        };

        const inspect = dependencies?.inspectVisualCapture ?? inspectFullPageVisualCapture;
        const visualInventory = await inspect(
            {
                vision: options.vision,
                reporterSymptom: options.reporterSymptom,
                artifactsDir: options.artifactsDir,
                recorder: options.recorder,
                // The experiment's cancellation, so an expired apply_rule deadline cancels the
                // batch's in-flight vision completion instead of paying out the rest of the images.
                ...(input.signal === undefined ? {} : { signal: input.signal }),
            },
            {
                artifactId: viewportArtifactId,
                fullPageArtifactId,
                tileCoverage: captured.tileCoverage,
            },
        );

        this.retainPhaseEvidence(input.phase, record, scan);

        const tiles = tileArtifactIds(captured.tileCoverage).map((artifactId) =>
            environmentArtifact(options.recorder, artifactId, EnvironmentArtifactKind.Screenshot),
        );
        const screenshots = [
            environmentArtifact(
                options.recorder,
                viewportArtifactId,
                EnvironmentArtifactKind.Screenshot,
            ),
            environmentArtifact(
                options.recorder,
                fullPageArtifactId,
                EnvironmentArtifactKind.Screenshot,
            ),
            ...tiles,
        ];
        const vision: EnvironmentArtifactReference = {
            artifactId: visualInventory.artifactId,
            kind: EnvironmentArtifactKind.Vision,
            path: visualInventory.artifactPath,
        };
        const capture: EnvironmentBrowserCapture = {
            visionVerified: visualInventory.coverageComplete,
            viewportArtifactId,
            viewport: screenshots[0]!.path,
            fullPageOverviewArtifactId: fullPageArtifactId,
            fullPageOverview: screenshots[1]!.path,
            tileArtifactIds: tiles.map((artifact) => artifact.artifactId),
            tiles: tiles.map((artifact) => artifact.path),
            coverageComplete: visualInventory.coverageComplete,
            reporterSymptomPresence: visualInventory.inventory.reporterSymptomPresence,
        };
        return {
            completion: {
                kind: 'observed',
                sessionId: input.proof.sessionId,
                targetUrl: toolString(opened.url, options.targetUrl),
                targetObservation: {
                    symptomPresent: this.symptomPresent(
                        input.phase,
                        visualInventory.inventory.reporterSymptomPresence,
                    ),
                    pageUsable: this.pageUsable(input.phase, scan),
                },
                navigationVerified: true,
                artifacts: [
                    ...screenshots,
                    environmentArtifact(
                        options.recorder,
                        harArtifactId,
                        EnvironmentArtifactKind.Har,
                    ),
                    environmentArtifact(
                        options.recorder,
                        domArtifactId,
                        EnvironmentArtifactKind.Dom,
                    ),
                    vision,
                    interactionArtifact,
                ],
                vision: {
                    artifactId: vision.artifactId,
                    verdict: visualInventory.coverageComplete ? 'verified' : 'inconclusive',
                },
                candidateValidation: null,
                rejectedCandidates: [],
                profile: options.profile,
                captures: [capture],
            },
            access,
            record,
        };
    }

    /**
     * Build the phase material for a page the run never reached.
     *
     * @param input - Common session plus exact adapter phase proof.
     * @param opened - Raw navigation result carrying the failure.
     * @returns Failed phase material carrying the navigation diagnosis.
     */
    private navigationFailure(
        input: AdsEnvironmentPhaseObservationInput,
        opened: Record<string, unknown>,
    ): ObservedAnnoyancePhase {
        const fallbackReason = opened.fallbackReason;
        return {
            completion: {
                kind: 'failed',
                sessionId: input.proof.sessionId,
                limitation: {
                    code: EnvironmentAdapterLimitationCode.PhaseProofUnavailable,
                    stage: EnvironmentLimitationStage.Phase,
                    detail: 'The Annoyance phase could not reach the reported page.',
                },
            },
            access: {
                statusCode: toolNumber(opened.statusCode, 0),
                title: toolString(opened.title, ''),
                htmlLength: 0,
                visibleTextPreview: '',
                navigationFailureReason:
                    typeof fallbackReason === 'string'
                        ? (fallbackReason as BrowserFallbackReason)
                        : BrowserFallbackReason.NavigationTimeout,
                navigationFailureDetail: String(opened.error),
            },
            record: null,
        };
    }

    /**
     * Retain the evidence one phase contributes to the investigation's comparisons.
     *
     * @param phase - Phase that produced the evidence.
     * @param record - Ordered interaction evidence for that phase.
     * @param scan - Post-interaction obstruction scan, or null when it could not be taken.
     */
    private retainPhaseEvidence(
        phase: EnvironmentPhase,
        record: SafeInteractionRecord,
        scan: AnnoyanceSurfaceScan | null,
    ): void {
        if (phase === PhaseLabel.B) {
            this.baselineRecord = record;
            this.baselineScan = scan;
            this.annoyanceTarget = selectAnnoyanceTarget(scan, record.steps.length - 1);
            return;
        }
        if (phase !== PhaseLabel.C) {
            return;
        }
        const target = this.annoyanceTarget;
        this.candidateCorrelation = target ? correlateAnnoyanceTarget(target, scan) : null;
        const baselineRecord = this.baselineRecord;
        // Without the sequence the baseline actually performed there is nothing to compare the
        // replay against, which the absent baseline scan reports as an unobservable page.
        this.candidateUsability = assessInteractedPageUsability({
            baselineScan: baselineRecord === null ? null : this.baselineScan,
            candidateScan: scan,
            baselineRecord: baselineRecord ?? record,
            candidateRecord: record,
        });
    }

    /**
     * Decide whether this phase still shows the reported annoyance.
     *
     * Vision keeps its single definition of "the reported symptom was seen"; for the candidate the
     * structural correlation may only add presence, never remove it.
     *
     * @param phase - Phase being observed.
     * @param visionPresence - Vision-owned presence across the complete capture.
     * @returns Whether the reported annoyance is still on the page.
     */
    private symptomPresent(
        phase: EnvironmentPhase,
        visionPresence: ReporterSymptomPresence,
    ): boolean {
        if (visionPresence !== ReporterSymptomPresence.Absent) {
            return true;
        }
        return phase === PhaseLabel.C && this.candidateCorrelation !== 'absent';
    }

    /**
     * Decide whether the page this phase drove is usable.
     *
     * @param phase - Phase being observed.
     * @param scan - Post-interaction obstruction scan, or null when it could not be taken.
     * @returns Whether the page remained usable.
     */
    private pageUsable(phase: EnvironmentPhase, scan: AnnoyanceSurfaceScan | null): boolean {
        return phase === PhaseLabel.C ? (this.candidateUsability?.usable ?? false) : scan !== null;
    }
}

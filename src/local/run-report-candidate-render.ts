/**
 * The candidate sections of the local agent report: the proposed edit and how it was reached, the
 * screenshot pairs factual validation rejected, the per-profile evidence, the visual review of the
 * candidate, the settings profiles the run applied, and the documentation revisions it cited.
 *
 * All pure `FixRunResult`/record-fragment -> `string[]` projections, called by `run-report-render`
 * and calling nothing back.
 */
import { describeCulpritRemoval } from '../repo/culprit-removal';
import { describeCulpritReplacement } from '../repo/culprit-replacement';
import { describeSharedRuleExtension } from '../repo/shared-rule-extension';
import { NOT_OBSERVED_TEXT } from '../environment/environment-proofs';
import type { FixRunResult } from '../types/fix-run-result';
import { RepositoryEditKind } from '../types/repository-edit-kind';
import type {
    LocalKnowledgeBaseProvenance,
    LocalProfileScreenshotEvidence,
    LocalRejectedCandidatePair,
    LocalSettingsProfileEvidence,
} from './run-output';
import { renderItemsOrFallback, renderOptional, renderPathList } from './run-report-values';

/**
 * Render rejected before/after pairs with their vision-review reason.
 *
 * @param pairs - Candidate screenshot pairs rejected during factual validation.
 * @returns Markdown sections that cannot be confused with verified evidence.
 */
export function renderRejectedPairs(pairs: LocalRejectedCandidatePair[]): string[] {
    if (pairs.length === 0) {
        return ['### Rejected before/after pairs', '', 'None.'];
    }
    return pairs.flatMap((pair) => [
        `### Rejected pair — ${pair.reason}`,
        '',
        ...renderPathList('Rejected before — viewport', pair.beforeScreenshots),
        '',
        ...renderPathList('Rejected after — viewport', pair.afterScreenshots),
        '',
        ...renderPathList('Rejected before — full page', pair.beforeFullPageScreenshots),
        '',
        ...renderPathList('Rejected after — full page', pair.afterFullPageScreenshots),
        '',
    ]);
}

/**
 * Render live screenshots grouped by the exact extension settings profile.
 *
 * @param profiles - Ordered profile screenshots captured during the local run.
 * @returns Markdown lines for every applied profile.
 */
export function renderProfileScreenshots(profiles: LocalProfileScreenshotEvidence[]): string[] {
    return profiles.flatMap((profile) => [
        ...renderPathList(`Profile — ${profile.name}`, profile.screenshots),
        '',
    ]);
}

/**
 * Render a candidate rule section for the local report.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines describing the candidate or its absence.
 */
export function renderCandidate(result: FixRunResult): string[] {
    const candidate = result.candidatePatch;
    if (!candidate) {
        return ['### Candidate', '', 'No candidate patch was produced.'];
    }
    const insertionEdit =
        candidate.repositoryEdit?.kind === RepositoryEditKind.Insert
            ? candidate.repositoryEdit
            : undefined;
    const insertionPoint = insertionEdit?.insertionPoint ?? candidate.insertionPoint;
    const repositoryEditLines: string[] = [];
    if (candidate.repositoryEdit?.kind === RepositoryEditKind.ExtendDomains) {
        repositoryEditLines.push(
            `- Extended source line: \`${candidate.repositoryEdit.line}\``,
            `- Replacement rule: \`${candidate.repositoryEdit.replacementRule}\``,
        );
        // The disclosure is derived from the patch rather than from a stored field, so a report can
        // never claim a narrower radius than the patch it describes. A structurally invalid
        // extension renders no disclosure at all rather than a partial one: the run cannot reach
        // publication with such a patch, since `applyRepositoryEdit` and `materializeReviewCheckout`
        // both refuse it.
        const extension = describeSharedRuleExtension(
            candidate.rule,
            candidate.repositoryEdit.originalRule,
            candidate.repositoryEdit.replacementRule,
        );
        if (extension) {
            repositoryEditLines.push(
                `- Verified scope: \`${extension.addedScope}\``,
                `- Also affected, not verified by this run: ${extension.retainedScopes
                    .map((scope) => `\`${scope}\``)
                    .join(', ')}`,
                `- Regression risk: \`${extension.retainedScopes.length > 0 ? 'elevated' : 'scoped'}\``,
            );
        }
    } else if (candidate.repositoryEdit?.kind === RepositoryEditKind.Replace) {
        // Derived from the patch for the same reason the extension disclosure is: a report must not
        // be able to claim a narrower radius than the replacement it describes. A structurally
        // invalid replacement renders no disclosure rather than a partial one, and cannot reach
        // publication anyway, since the gate and the source lock both refuse it.
        const replacement = describeCulpritReplacement(
            candidate.repositoryEdit.originalRule,
            candidate.repositoryEdit.replacementRule,
        );
        if (replacement) {
            repositoryEditLines.push(
                `- Replaced source line: \`${candidate.repositoryEdit.line}\``,
                `- Original rule: \`${candidate.repositoryEdit.originalRule}\``,
                `- Also affected, not verified by this run: ${
                    replacement.affectedScopes.length === 0
                        ? 'every site this rule matches'
                        : replacement.affectedScopes.map((scope) => `\`${scope}\``).join(', ')
                }`,
                '- Regression risk: `elevated` — only the reported site was validated experimentally',
            );
        }
    } else if (candidate.repositoryEdit?.kind === RepositoryEditKind.Remove) {
        // Derived from the patch for the same reason the sibling disclosures are, and it is the
        // only bound this report can offer: a deletion takes the rule away everywhere it reached,
        // so the scope list is the disclosure rather than a proof of containment.
        const removal = describeCulpritRemoval(candidate.repositoryEdit.originalRule);
        if (removal) {
            repositoryEditLines.push(
                `- Removed source line: \`${candidate.repositoryEdit.line}\``,
                `- Removed rule: \`${candidate.repositoryEdit.originalRule}\``,
                `- Also affected, not verified by this run: ${
                    removal.affectedScopes.length === 0
                        ? 'every site this rule matches'
                        : removal.affectedScopes.map((scope) => `\`${scope}\``).join(', ')
                }`,
                '- Regression risk: `elevated` — only the reported site was validated experimentally',
            );
        }
    }
    const anchorLines: string[] = [];
    if (insertionEdit?.anchorRule) {
        anchorLines.push(`- Insert before rule: \`${insertionEdit.anchorRule}\``);
    }
    return [
        '### Candidate',
        '',
        `- Rule type: \`${candidate.ruleType}\``,
        `- Syntax kind: \`${candidate.syntaxKind ?? 'unknown'}\``,
        `- File: \`${candidate.filePath}\``,
        `- Repository edit: \`${candidate.repositoryEdit?.kind ?? 'legacy_insert'}\``,
        ...repositoryEditLines,
        `- Insertion point: \`${insertionPoint ?? 'n/a'}\``,
        ...anchorLines,
        '- Rule:',
        '',
        '```adblock',
        candidate.rule,
        '```',
    ];
}

/**
 * Render the typed semantic verdict produced by the dedicated vision model.
 *
 * @param result - Locked core run result.
 * @returns Markdown lines describing the visual review or its absence.
 */
export function renderCandidateVisualReview(result: FixRunResult): string[] {
    const review = result.candidateVisualReview;
    if (!review) {
        return ['### Vision review', '', 'No runner-bound candidate vision review was produced.'];
    }

    return [
        '### Vision review',
        '',
        `- Verdict: \`${review.verdict}\``,
        `- Symptom: \`${review.symptom}\``,
        `- Symptom scope: ${review.symptomScope}`,
        `- Full-page coverage: \`${review.coverageComplete ? 'complete' : 'incomplete'}\``,
        `- Page integrity: \`${review.pageIntegrity}\``,
        `- Model: \`${review.model}\``,
        `- Validation artifact: \`${review.validationArtifactId}\``,
        `- Rationale: ${review.rationale}`,
        '- Before instances:',
        ...renderItemsOrFallback(
            review.beforeInstances,
            (instance) =>
                `  - \`${instance.artifactId}\` — ${instance.landmark}: ${instance.description}`,
            '  - None identified.',
        ),
        '- Remaining instances:',
        ...renderItemsOrFallback(
            review.remainingInstances,
            (instance) =>
                `  - \`${instance.artifactId}\` — ${instance.landmark}: ${instance.description}`,
            '  - None identified.',
        ),
        '- Observed damage:',
        ...renderItemsOrFallback(
            review.observedDamage,
            (damage) => `  - ${damage}`,
            '  - None observed.',
        ),
    ];
}

/**
 * Render settings-profile provenance and its independent proof sources.
 *
 * @param profiles - Settings profiles attempted during the run.
 * @returns Markdown lines for all profiles.
 */
export function renderSettingsProfiles(profiles: LocalSettingsProfileEvidence[]): string[] {
    const lines = ['### Settings profiles', ''];
    if (profiles.length === 0) {
        lines.push('None.');
        return lines;
    }
    for (const profile of profiles) {
        lines.push(
            `#### \`${profile.name}\``,
            '',
            `- Status: \`${profile.status}\``,
            `- Detail: ${renderOptional(profile.detail)}`,
            `- Activation proof: \`${profile.activationProof}\``,
            '',
        );
        if (profile.enabledFilters === null) {
            lines.push(`- Enabled filters: ${NOT_OBSERVED_TEXT}.`, '');
            continue;
        }
        if (profile.enabledFilters.length === 0) {
            lines.push('- None enabled.', '');
            continue;
        }
        lines.push(
            '| ID | Name | Group | Version | Metadata | Runtime |',
            '| --- | --- | --- | --- | --- | --- |',
            ...profile.enabledFilters.map(
                (filter) =>
                    `| ${filter.id} | ${filter.name} | ${renderOptional(filter.group)} | ` +
                    `${renderOptional(filter.version)} | ${filter.metadataEnabled ? 'yes' : 'no'} | ` +
                    `${filter.runtimeEnabled ? 'yes' : 'no'} |`,
            ),
            '',
        );
    }
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/**
 * Render exact documentation revisions and citations used by the agent.
 *
 * @param knowledge - Optional prepared documentation provenance.
 * @returns Human-readable KnowledgeBase provenance lines.
 */
export function renderKnowledgeBaseProvenance(
    knowledge: LocalKnowledgeBaseProvenance | null | undefined,
): string[] {
    if (!knowledge) {
        return ['- KnowledgeBase: `n/a`'];
    }
    const lines = [
        `- KnowledgeBase source: \`${knowledge.source}\``,
        `- KnowledgeBase source location: \`${knowledge.sourceLocation}\``,
        `- KnowledgeBase requested revision: \`${knowledge.requestedRevision}\``,
        `- KnowledgeBase commit: \`${knowledge.commit}\``,
        `- KnowledgeBase filters commit: \`${knowledge.filtersCommit}\``,
        `- KnowledgeBase allowlisted documents: ${knowledge.documents
            .map((document) => `\`${document}\``)
            .join(', ')}`,
    ];
    if (knowledge.citations.length === 0) {
        lines.push('- KnowledgeBase citations used: none');
        return lines;
    }
    lines.push('- KnowledgeBase citations used:');
    lines.push(
        ...knowledge.citations.map(
            (citation) =>
                `  - \`${citation.topic}\`: [${citation.filePath}#${citation.anchor}]` +
                `(${citation.url})`,
        ),
    );
    return lines;
}

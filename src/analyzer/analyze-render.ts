/**
 * Human-readable rendering of a sealed analyze outcome. The terminal payload is the only analysis
 * channel; failure seals render their kind-specific reason. There is deliberately no prose fallback
 * — the legacy text report no longer exists. Split from analyze-session.ts so both modules stay
 * under the repo's 500-line ceiling.
 */
import { SealKind, type TerminalOutcome } from '../pi/seal-types';
import { FixOutcomeKind, type FixOutcome } from '../pr/fix-outcome';

/**
 * Render the sealed analyze outcome for the CLI user.
 *
 * @param outcome - The sealed pi outcome.
 * @returns The human-readable rendering.
 */
export function renderAnalyzeOutcome(outcome: TerminalOutcome<FixOutcome>): string {
    switch (outcome.kind) {
        case SealKind.Terminal: {
            const report = outcome.payload;
            const lines = [
                `Outcome: ${report.outcome}`,
                `Summary: ${report.summary ?? '—'}`,
                `Reasoning: ${report.reasoning}`,
            ];
            if (report.outcome === FixOutcomeKind.DraftPr) {
                lines.push(
                    `Rule: ${report.ruleProposal.rule}`,
                    `Rule type: ${report.ruleProposal.ruleType}`,
                    `Risk: ${report.ruleProposal.risk.level} ` +
                        `(score ${report.ruleProposal.risk.score}), ` +
                        `action ${report.ruleProposal.risk.requiredAction}`,
                    `Placement: ${report.ruleProposal.placement.filter} → ` +
                        `${report.ruleProposal.placement.filePath} ` +
                        `(confidence ${report.ruleProposal.placement.confidence})`,
                );
            }
            if (report.outcome === FixOutcomeKind.ProposeClose) {
                lines.push(
                    `Policy decision: ${report.policyDecision.decision} — ` +
                        report.policyDecision.reasons.join('; '),
                );
            }
            return lines.join('\n');
        }
        case SealKind.RejectedTerminal:
            return [
                `The analysis report was rejected ${outcome.rejections} times; ` +
                    'the run was sealed without a valid report.',
                `Last rejection: ${outcome.lastReason ?? 'no reason recorded'}`,
            ].join('\n');
        case SealKind.NoTerminal:
            return `The run ended without an analysis report. ${outcome.diagnosis}`;
        case SealKind.ProviderFailure:
            return `The provider failed: ${outcome.message}`;
        case SealKind.BudgetExceeded:
            return `The run exhausted its ${outcome.budget} budget: ${outcome.detail}`;
        case SealKind.Aborted:
            return 'The run was aborted.';
    }
}

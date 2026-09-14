import type { EvidencePack } from '../types/evidence-pack';

/**
 * Render a policy decision as an emoji + readable label for the evidence table.
 *
 * @param decision - The policy decision string.
 * @returns An emoji prefix followed by the space-separated decision label.
 */
function policyLabel(decision: string): string {
    const emoji =
        decision === 'allow_rule_generation'
            ? '\u2705'
            : decision === 'propose_close'
              ? '\uD83D\uDEAB'
              : '\u26A0\uFE0F';
    return `${emoji} ${decision.replace(/_/g, ' ')}`;
}

/**
 * Build the reviewer-first PR description Markdown from an assembled evidence pack.
 *
 * Follows the template in REQUIREMENTS.md \u00a711: Closes #N, TL;DR, Rule, Evidence table,
 * Screenshots, Analysis (problem/approach/placement), and Risk Assessment (only when risk > low).
 *
 * @param pack - The assembled evidence pack.
 * @returns The PR description body as a Markdown string.
 */
export function buildPrDescription(pack: EvidencePack): string {
    const issueNumber = pack.issue.issueNumber;
    const proposal = pack.ruleProposal;
    const risk = proposal?.risk;
    const placement = proposal?.placement;
    const dup = proposal?.duplicateCheck;

    const lines: string[] = [];

    lines.push(`## Closes #${issueNumber}`, '');

    lines.push('### TL;DR', '');
    if (proposal) {
        lines.push(
            `Added a ${proposal.ruleType} rule to fix a missed ad reported on the site.`,
            '',
        );
    } else {
        lines.push('Investigation completed; see analysis below.', '');
    }

    lines.push('### Rule', '', '```', proposal?.rule ?? '(no rule)', '```', '');

    lines.push('### Evidence', '');
    lines.push('| Check | Result |');
    lines.push('|-------|--------|');
    lines.push(`| Policy gate | ${policyLabel(pack.policyDecision.decision)} |`);
    lines.push(`| Duplicate check | ${dup ? dup.classification : 'n/a'} |`);
    lines.push(`| Risk score | ${risk ? `${risk.score}/5 (${risk.level})` : 'n/a'} |`);
    lines.push(
        `| Product compat | ${proposal?.productCompatibility.extension ? '\u2705 extension' : '\u26A0\uFE0F check'} |`,
    );
    // Runtime-validation row intentionally omitted for MVP (finding 7): the three-phase validator's
    // `FactualValidationResult` carries no verdict (the verdict is LLM-determined and not threaded
    // through `FixOutcome`), so the row would always read "not run". It will be re-added once a
    // `ValidationResult.verdict` is threaded through the evidence pack.

    lines.push('', '### Screenshots', '');
    lines.push('| Before | After |');
    lines.push('|--------|-------|');
    const maxShots = Math.max(pack.screenshotsBefore.length, pack.screenshotsAfter.length, 1);
    for (let i = 0; i < maxShots; i++) {
        const before = pack.screenshotsBefore[i] ?? '\u2014';
        const after = pack.screenshotsAfter[i] ?? '\u2014';
        lines.push(`| ${before} | ${after} |`);
    }

    lines.push('', '### Analysis', '');
    lines.push(`**Problem:** ${pack.reasoning}`);
    if (proposal) {
        lines.push(`**Approach:** A ${proposal.ruleType} rule targeting the reported domain.`);
    }
    if (placement) {
        lines.push(
            `**Placement:** ${placement.filePath} (${placement.filter}, confidence ${placement.confidence})`,
        );
    }

    if (risk && risk.level !== 'low') {
        lines.push('', '### Risk Assessment');
        lines.push(
            `- Blast radius: ${risk.blastRadiusFlags.length > 0 ? risk.blastRadiusFlags.join(', ') : 'none'}`,
        );
        lines.push(`- Reasons: ${risk.reasons.join('; ')}`);
        lines.push(`- Required action: ${risk.requiredAction}`);
    }

    return lines.join('\n') + '\n';
}

/**
 * Build a structured propose-close comment from an evidence pack.
 *
 * Used when the agent cannot reproduce the ad or policy blocks rule generation. The comment is
 * posted on the issue (not closed) with evidence so a human can act on it.
 *
 * @param pack - The assembled evidence pack.
 * @returns The propose-close comment body as a Markdown string.
 */
export function buildProposeCloseComment(pack: EvidencePack): string {
    const issueNumber = pack.issue.issueNumber;
    const lines: string[] = [];
    lines.push(`### Propose-close \u2014 issue #${issueNumber}`, '');
    lines.push(`**Policy decision:** ${pack.policyDecision.decision.replace(/_/g, ' ')}`, '');
    for (const reason of pack.policyDecision.reasons) {
        lines.push(`- ${reason}`);
    }
    lines.push('', '**Reasoning:**', '', pack.reasoning, '');
    if (pack.screenshotsBefore.length > 0) {
        lines.push('**Before screenshots:**', '');
        for (const shot of pack.screenshotsBefore) {
            lines.push(`- ${shot}`);
        }
        lines.push('');
    }
    lines.push(
        '> The agent does not close this issue automatically. A human should review the evidence and decide whether to close.',
    );
    return lines.join('\n') + '\n';
}

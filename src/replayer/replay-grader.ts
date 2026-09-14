import { writeFileSync } from 'node:fs';
import { RuleKind, normalizeRule } from '../repo/rule-normalizer';
import {
    type JudgeVerdict,
    type ReplayCase,
    type Rubric,
    type ReproductionSignal,
} from '../types/replay';

/**
 * The agent's replay output to be graded against a gold case.
 */
export interface ReplayAgentOutput {
    /**
     * The closure type the agent produced (one of the ClosureType values, e.g. 'merged-fix').
     */
    agentOutcome: string;

    /**
     * The rules the agent proposed during replay.
     */
    agentRules: string[];

    /**
     * The target filter file path the agent chose, if any.
     */
    agentPlacement?: string;
}

/**
 * The result of grading an agent's replay output against a gold case.
 */
export interface ReplayGradeResult {
    /**
     * The four rubric booleans scored against the gold case.
     */
    rubric: Rubric;

    /**
     * The semantic judge verdict and rationale.
     */
    judgeVerdict: JudgeVerdict;
}

/**
 * Extract the primary target domain from a list of rules.
 *
 * For network rules the host after `||` is used; for cosmetic/scriptlet rules the domain prefix
 * before the `##`-style separator is used. The first rule that yields a domain wins.
 *
 * @param rules - The raw rule lines to inspect.
 * @returns The lowercased primary target domain, or null if none can be extracted.
 */
function extractTargetDomain(rules: string[]): string | null {
    for (const rule of rules) {
        const normalized = normalizeRule(rule);
        if (normalized.kind === RuleKind.Cosmetic || normalized.kind === RuleKind.Scriptlet) {
            if (normalized.domains.length > 0) {
                return normalized.domains[0];
            }
            continue;
        }
        if (normalized.kind === RuleKind.Network) {
            let pattern = normalized.urlPattern ?? '';
            pattern = pattern.replace(/^\|+/, '');
            const end = pattern.search(/[\^/*$]/);
            const host = end === -1 ? pattern : pattern.slice(0, end);
            if (host.length > 0) {
                return host;
            }
        }
    }
    return null;
}

/**
 * Build a canonical, order-independent set of rule forms.
 *
 * Each rule is normalized via {@link normalizeRule} and its `canonical` string collected into a
 * deduplicated set.
 *
 * @param rules - The raw rule lines.
 * @returns A set of canonical rule strings.
 */
function canonicalSetOf(rules: string[]): Set<string> {
    return new Set(rules.map((rule) => normalizeRule(rule).canonical));
}

/**
 * Determine whether two sets contain the same members.
 *
 * @param a - The first set.
 * @param b - The second set.
 * @returns True when both sets have equal size and identical members.
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const item of a) {
        if (!b.has(item)) {
            return false;
        }
    }
    return true;
}

/**
 * Grade the agent's replay output against the gold case.
 *
 * Scoring is purely semantic: rules are compared via their normalized canonical forms and target
 * domains, never by textual identity. The function performs no I/O.
 *
 * @param gold - The gold replay case built from the closed issue.
 * @param agent - The agent's replay output to grade.
 * @returns The rubric and judge verdict.
 */
export function gradeReplay(gold: ReplayCase, agent: ReplayAgentOutput): ReplayGradeResult {
    const outcomeClassMatch = agent.agentOutcome === gold.closureType;

    const goldDomain = extractTargetDomain(gold.goldRules);
    const agentDomain = extractTargetDomain(agent.agentRules);
    const targetDomainMatch =
        goldDomain !== null && agentDomain !== null && goldDomain === agentDomain;

    const normalizedRuleEquivalent = setsEqual(
        canonicalSetOf(gold.goldRules),
        canonicalSetOf(agent.agentRules),
    );

    const filterFileMatch =
        gold.goldPlacement != null &&
        agent.agentPlacement != null &&
        gold.goldPlacement === agent.agentPlacement;

    const rubric: Rubric = {
        outcomeClassMatch,
        targetDomainMatch,
        normalizedRuleEquivalent,
        filterFileMatch,
    };

    const matched: string[] = [];
    if (outcomeClassMatch) {
        matched.push('outcomeClassMatch');
    }
    if (targetDomainMatch) {
        matched.push('targetDomainMatch');
    }
    if (normalizedRuleEquivalent) {
        matched.push('normalizedRuleEquivalent');
    }
    if (filterFileMatch) {
        matched.push('filterFileMatch');
    }
    const count = matched.length;
    const verdict: JudgeVerdict['verdict'] =
        count >= 3 ? 'equivalent' : count >= 1 ? 'partial' : 'different';
    const rationale =
        matched.length > 0 ? `matched: ${matched.join(', ')}` : 'no rubric fields matched';

    return {
        rubric,
        judgeVerdict: { verdict, rationale },
    };
}

/**
 * Render a boolean rubric value as a checkmark marker.
 *
 * @param value - The boolean to render.
 * @returns '✓' when true, otherwise '✗'.
 */
const mark = (value: boolean): string => (value ? '✓' : '✗');

/**
 * Render the comparison as a Markdown report and write it to disk.
 *
 * @param gold - The gold replay case.
 * @param agent - The agent's replay output.
 * @param result - The grading result produced by {@link gradeReplay}.
 * @param reproduced - The decoupled drift signal ('true'/'false'/'n/a') derived by the runner from
 *   the browser session, independent of patch grading.
 * @param mdArtifactPath - The file path to write the report to.
 * @returns The written artifact path (equal to mdArtifactPath).
 */
export function writeReplayReport(
    gold: ReplayCase,
    agent: ReplayAgentOutput,
    result: ReplayGradeResult,
    reproduced: ReproductionSignal,
    mdArtifactPath: string,
): string {
    const { rubric, judgeVerdict } = result;
    const goldCanonical = [...canonicalSetOf(gold.goldRules)].sort();
    const agentCanonical = [...canonicalSetOf(agent.agentRules)].sort();

    const report = `# Replay Comparison

## Summary

| Field | Gold | Agent |
|-------|------|-------|
| Closure type | ${gold.closureType} | ${agent.agentOutcome} |
| Reproduced | ${reproduced} | |
| Verdict | ${judgeVerdict.verdict} | |

## Rubric

| Criterion | Match |
|-----------|-------|
| outcomeClassMatch | ${mark(rubric.outcomeClassMatch)} |
| targetDomainMatch | ${mark(rubric.targetDomainMatch)} |
| normalizedRuleEquivalent | ${mark(rubric.normalizedRuleEquivalent)} |
| filterFileMatch | ${mark(rubric.filterFileMatch)} |

## Rules (canonical form)

### Gold
${goldCanonical.map((rule) => `- \`${rule}\``).join('\n')}

### Agent
${agentCanonical.map((rule) => `- \`${rule}\``).join('\n')}

## Rationale

${judgeVerdict.rationale}
`;

    writeFileSync(mdArtifactPath, report, 'utf8');
    return mdArtifactPath;
}

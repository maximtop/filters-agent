import {
    GuidanceDocumentOrigin,
    GuidanceDocumentRole,
    MAX_GUIDANCE_CHARACTERS,
    type InstructionGuidanceSource,
    type InstructionLinkedDocument,
} from './guidance-source';
import type {
    KnowledgeGuidanceCitation,
    RuleGuidanceResult,
    RuleGuidanceTopic,
} from './rule-guidance';

/**
 * Stable marker distinguishing a typed not-linked notice from a served excerpt.
 */
export const RuleGuidanceNotice = {
    /**
     * The requested topic maps to roles the run instruction did not link.
     */
    NotLinked: 'not_linked',
} as const;

/**
 * Every RuleGuidanceNotice value, for schemas and exhaustive listings.
 */
export const RULE_GUIDANCE_NOTICE_VALUES = Object.values(RuleGuidanceNotice);

/**
 * RuleGuidanceNotice value.
 */
export type RuleGuidanceNotice = (typeof RuleGuidanceNotice)[keyof typeof RuleGuidanceNotice];

/**
 * Anchor naming a citation that covers a served-whole instruction document instead of a pinned
 * KnowledgeBase section heading.
 */
export const WHOLE_DOCUMENT_ANCHOR = 'whole-document';

/**
 * Instruction-serving map from every public guidance topic to the run instruction's roles that
 * define it, in serving order: a topic serves its whole role documents in this order, and one
 * missing role turns the lookup into the typed not-linked notice.
 */
export const INSTRUCTION_TOPIC_ROLES: Record<RuleGuidanceTopic, readonly GuidanceDocumentRole[]> = {
    element_hiding: [GuidanceDocumentRole.Syntax],
    css_injection: [GuidanceDocumentRole.Syntax],
    extended_css: [GuidanceDocumentRole.Syntax],
    network: [GuidanceDocumentRole.Syntax],
    scriptlet: [GuidanceDocumentRole.Syntax],
    exception: [GuidanceDocumentRole.Syntax],
    compatibility: [GuidanceDocumentRole.Syntax],
    placement: [GuidanceDocumentRole.Policy, GuidanceDocumentRole.Contributing],
};

/**
 * Build the typed not-linked notice for a topic whose roles the instruction did not link.
 *
 * This notice is the deterministic record point for the missing-information flow: the guidance tool
 * result itself carries the subject/detail a run harvests, so the gap reaches the run result even
 * when the model never calls the missing-information tool.
 *
 * @param topic - Validated lookup subject the agent asked for.
 * @param source - Instruction source that lacks the linked role document.
 * @param missing - Roles of the topic that no linked document fills.
 * @returns The notice result carrying the missing-information subject and detail.
 */
export function notLinkedResult(
    topic: RuleGuidanceTopic,
    source: InstructionGuidanceSource,
    missing: readonly GuidanceDocumentRole[],
): RuleGuidanceResult {
    const missingNames = missing.join(' or ');
    const roleNames = INSTRUCTION_TOPIC_ROLES[topic].join(' and ');
    const linkedRoles = source.documents.map((document) => document.role);
    const rosterText =
        linkedRoles.length === 0
            ? 'no role documents at all'
            : `only the ${linkedRoles.join(', ')} document(s)`;
    const subject = `No ${missingNames} document is linked for rule guidance topic ${topic}`;
    const guidance =
        `No ${missingNames} document is linked by this run's instruction, so the ${topic} topic ` +
        'has no authoritative text to serve. Work from the instruction itself and the documents ' +
        `it does link (${rosterText}), and record exactly what is missing.`;
    const detail =
        `Rule guidance topic ${topic} is defined by the run instruction's ${roleNames} ` +
        `document(s), but the instruction at ${source.path} links ${rosterText}. The ` +
        `${missingNames} guidance is absent for this run; record exactly what is missing so the ` +
        'run report can name the gap.';
    return {
        topic,
        guidance,
        maxCharacters: MAX_GUIDANCE_CHARACTERS,
        citations: [],
        notice: RuleGuidanceNotice.NotLinked,
        missingInformation: { subject, detail },
    };
}

/**
 * GitHub URL pattern isolating the owner and repository of a document hosted on GitHub: the one
 * host whose URLs name a repository slug a citation can carry.
 */
const GITHUB_DOCUMENT_URL_PATTERN =
    /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/#?\s]+)\/([^/#?\s]+)/iu;

/**
 * Build the citation of one served instruction document.
 *
 * A URL-sourced document carries a commit-less citation — it has no immutable revision to name —
 * located by the source URL and the whole-document anchor. A checkout-origin document carries no
 * citation at all: its locator is a moving local path, and the document's identity rides the source
 * digest instead.
 *
 * @param document - Instruction document served for the requested topic.
 * @returns The citation when the document has a stable URL locator, otherwise undefined.
 */
export function instructionDocumentCitation(
    document: InstructionLinkedDocument,
): KnowledgeGuidanceCitation | undefined {
    if (document.origin !== GuidanceDocumentOrigin.Url) {
        return undefined;
    }
    let parsed: URL;
    try {
        parsed = new URL(document.url);
    } catch {
        return undefined;
    }
    const githubMatch = GITHUB_DOCUMENT_URL_PATTERN.exec(document.url);
    const repository =
        githubMatch?.[1] !== undefined && githubMatch?.[2] !== undefined
            ? `${githubMatch[1]}/${githubMatch[2]}`
            : parsed.host;
    let filePath = decodeURIComponent(parsed.pathname).replace(/^\//u, '');
    if (filePath.length === 0) {
        filePath = parsed.host;
    }
    return {
        repository,
        commit: undefined,
        filePath,
        anchor: WHOLE_DOCUMENT_ANCHOR,
        url: document.url,
    };
}

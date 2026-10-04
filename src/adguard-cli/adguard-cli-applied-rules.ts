/**
 * The AdGuard CLI proxy's own reports, read as an applied-rules report.
 *
 * The proxy writes one access-log line per request, carrying the text of the network rule that
 * decided it, and one output-log line per element it removed from served HTML, carrying the rule
 * that removed it. Inside the page it reports the rest (`adguard-cli-page-reports.ts`): the script
 * rules its content script injects, and the rule that hides each hidden element. None of it names a
 * list, so a rule's list is found here by an exact line match among the lists the run itself
 * executes. The one gap left is named in the report instead of being silently absent: the rules the
 * proxy counts on a request without logging their text.
 *
 * The logs have no page boundary and survive a proxy restart, so one log is bound to one browser
 * session: it reads only what the proxy appended after the session launched, and only while the
 * proxy the session rides is still the one running.
 */
import { readFile } from 'node:fs/promises';
import {
    AppliedRuleFamily,
    AppliedRuleReporter,
    AppliedRulesReadKind,
    type AppliedRuleEvent,
    type AppliedRulesLog,
} from '../environment/applied-rules';
import { OFFICIAL_ADGUARD_FILTERS } from '../environment/official-filter-catalog';
import { normalizeRule } from '../repo/rule-normalizer';
import type { AdguardCliPageReports } from './adguard-cli-page-reports';
import type { ProxyFilterList } from './proxy-host';

/**
 * How the report names the engine.
 */
export const ADGUARD_CLI_ENGINE_NAME = 'AdGuard CLI';

/**
 * The period one read covers.
 */
const COVERS =
    'Every request the proxy filtered and every script it injected since this browser session ' +
    'started, on any page (its logs have no page boundary); element hiding as the frames of the ' +
    'current page show it at the moment of the read.';

/**
 * What the proxy applies without ever naming it.
 */
const NOT_REPORTED: readonly string[] = [
    'Network rules other than the one that decided a request: document-level exceptions ' +
        '($document, $elemhide, $generichide, $specifichide, $jsinject, $content) and rules that ' +
        'modify a request or response ($csp, $permissions, $removeparam, $removeheader, $cookie, ' +
        '$replace, $referrerpolicy, $hls, $jsonprune, $xmlprune, $urltransform). The proxy counts ' +
        'them on the request but never logs their text.',
    'Hiding by extended CSS (#?#) rules and by CSS rules that set their own content: the proxy ' +
        'marks neither on the element it hides.',
];

/**
 * One AdGuard CLI access-log line: `date time "listener" PROTOCOL METHOD URL REFERRER STATUS TYPE
 * RESULT N FILTER ADDRESS BYTESb DURATIONms -- RULE`. The rule is everything after `--`, empty when
 * none acted; TCP and TLS lines carry `-` for the status and do not match.
 */
const ADGUARD_CLI_ACCESS_LOG_LINE =
    /^\S+ \S+ "[^"]*" \S+ \S+ (?<url>\S+) \S+ \d+ \S+ \S+ \d+ \S+ \S+ \d+b \d+ms -- ?(?<rule>.*)$/u;

/**
 * One AdGuard CLI line for a connection it refused at the TLS handshake, before any request: `date
 * time "listener" TLS - HOST - - TYPE BLOCKED N FILTER - BYTESb DURATIONms -- RULE`. Only the host
 * is known. The browser already sees such a request fail, so the blocked-request reader skips these
 * lines; the applied-rules reader reports the rule against the host.
 */
const ADGUARD_CLI_TLS_BLOCK_LINE =
    /^\S+ \S+ "[^"]*" TLS - (?<url>\S+) - - \S+ BLOCKED \d+ \S+ \S+ \d+b \d+ms -- (?<rule>.+)$/u;

/**
 * The request and the rule one access-log line names.
 */
export interface AccessLogEntry {
    /**
     * Requested URL, or the bare host of a connection refused at the TLS handshake.
     */
    url: string;

    /**
     * Whether the line is a connection refused at the TLS handshake, which names only a host.
     */
    handshakeBlock: boolean;

    /**
     * Text of the network rule that acted on the request, empty when none did.
     */
    rule: string;
}

/**
 * Parse one AdGuard CLI access-log line.
 *
 * @param line - One complete log line.
 * @returns The request and rule, or undefined for a line that names no request.
 */
export function parseAccessLogLine(line: string): AccessLogEntry | undefined {
    const request = ADGUARD_CLI_ACCESS_LOG_LINE.exec(line)?.groups;
    if (request !== undefined) {
        return { url: request.url!, rule: request.rule!.trimEnd(), handshakeBlock: false };
    }
    const handshake = ADGUARD_CLI_TLS_BLOCK_LINE.exec(line)?.groups;
    return handshake === undefined
        ? undefined
        : { url: handshake.url!, rule: handshake.rule!.trimEnd(), handshakeBlock: true };
}

/**
 * One output-log line announcing an element the proxy removed from served HTML.
 */
const ELEMENT_REMOVED_LINE =
    /onHtmlElementRemoved: \[[^\]]*\] rule:(?<rule>.+?) url:(?<url>\S*) element name:(?<element>\S+)/u;

/**
 * Line break of the logs and of the list files.
 */
const LINE_BREAK = /\r?\n/u;

/**
 * What one session's log reads.
 */
export interface AdguardCliAppliedRulesLogInput {
    /**
     * The proxy's access log.
     */
    accessLogPath: string;

    /**
     * The proxy's own output log.
     */
    outputLogPath: string;

    /**
     * Access-log size when the session launched; only later bytes belong to the session.
     */
    accessLogOffset: number;

    /**
     * Output-log size when the session launched.
     */
    outputLogOffset: number;

    /**
     * The lists the proxy executes for the session.
     */
    lists: readonly ProxyFilterList[];

    /**
     * What the proxy reports inside the session's pages.
     */
    page: AdguardCliPageReports;

    /**
     * Whether the proxy the session rides is still the running one.
     */
    stillCurrent: () => boolean;
}

/**
 * Read what a log gained since an offset.
 *
 * @param path - The log file.
 * @param offset - Bytes that were there before.
 * @returns The appended lines.
 */
async function linesSince(path: string, offset: number): Promise<string[]> {
    return (await readFile(path)).subarray(offset).toString('utf8').split(LINE_BREAK);
}

/**
 * Find which executed lists hold each rule as an exact line.
 *
 * Every list is split once per read rather than indexed for the session: the Tracking Protection
 * list alone runs past 300,000 lines, and a read needs only the few dozen rules it reports.
 *
 * @param rules - The rules the read reports.
 * @param lists - The executed lists.
 * @returns List ids per rule, in list order.
 */
function listsHolding(
    rules: ReadonlySet<string>,
    lists: readonly ProxyFilterList[],
): Map<string, number[]> {
    const holders = new Map<string, number[]>();
    for (const list of lists) {
        for (const line of list.content.split(LINE_BREAK)) {
            if (!rules.has(line)) {
                continue;
            }
            const ids = holders.get(line) ?? [];
            if (!ids.includes(list.filterId)) {
                ids.push(list.filterId);
            }
            holders.set(line, ids);
        }
    }
    return holders;
}

/**
 * Create the applied-rules log of one browser session on the AdGuard CLI route.
 *
 * A hiding marker is read off the page, and a page can write one itself, so a marked rule counts
 * only when an executed list holds it. The logs and the injected scripts come from the proxy, and
 * their rules count even when no executed list holds them — the agent's own candidate rules, say.
 *
 * @param input - The logs, the session's offsets, the executed lists, the page reports, and the
 *   restart check.
 * @returns The session's log.
 */
export function createAdguardCliAppliedRulesLog(
    input: AdguardCliAppliedRulesLogInput,
): AppliedRulesLog {
    return {
        read: async () => {
            if (!input.stillCurrent()) {
                return {
                    kind: AppliedRulesReadKind.Unavailable,
                    reason:
                        'The proxy restarted after this browser session started (a candidate ' +
                        'experiment or a new enabled list set moves it to a new port), so this ' +
                        'session no longer reaches it and its log ended there. Launch a new ' +
                        'browser session and read again.',
                };
            }
            const found: Array<Omit<AppliedRuleEvent, 'filterIds'>> = [];
            for (const line of await linesSince(input.accessLogPath, input.accessLogOffset)) {
                const match = parseAccessLogLine(line);
                if (match === undefined || match.rule.length === 0) {
                    continue;
                }
                found.push({
                    rule: match.rule,
                    family: normalizeRule(match.rule).isException
                        ? AppliedRuleFamily.NetworkException
                        : AppliedRuleFamily.Network,
                    target: match.url,
                    reportedBy: [AppliedRuleReporter.Engine],
                });
            }
            for (const line of await linesSince(input.outputLogPath, input.outputLogOffset)) {
                const match = ELEMENT_REMOVED_LINE.exec(line)?.groups;
                if (match === undefined) {
                    continue;
                }
                found.push({
                    rule: match.rule!,
                    family: AppliedRuleFamily.HtmlFiltering,
                    target: `${match.element} ${match.url}`,
                    reportedBy: [AppliedRuleReporter.Engine],
                });
            }
            for (const injected of await input.page.injectedScripts()) {
                found.push({
                    rule: injected.rule,
                    family: AppliedRuleFamily.Script,
                    target: injected.frameUrl,
                    reportedBy: [AppliedRuleReporter.Engine],
                });
            }
            const marked = (await input.page.hiddenElements()).map((hidden) => ({
                rule: hidden.rule,
                family: AppliedRuleFamily.ElementHiding,
                target: hidden.element,
                reportedBy: [AppliedRuleReporter.Engine],
            }));
            const holders = listsHolding(
                new Set([...found, ...marked].map((event) => event.rule)),
                input.lists,
            );
            const events = [...found, ...marked.filter((event) => holders.has(event.rule))].map(
                (event) => ({ ...event, filterIds: holders.get(event.rule) ?? [] }),
            );
            const referenced = new Set(events.flatMap((event) => event.filterIds));
            return {
                kind: AppliedRulesReadKind.Report,
                report: {
                    engine: ADGUARD_CLI_ENGINE_NAME,
                    covers: COVERS,
                    events,
                    lists: OFFICIAL_ADGUARD_FILTERS.filter((filter) =>
                        referenced.has(filter.filterId),
                    ).map((filter) => ({ id: filter.filterId, name: filter.name })),
                    trackingProtection: [],
                    notReported: NOT_REPORTED,
                },
            };
        },
    };
}

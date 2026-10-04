/**
 * The requests the AdGuard CLI proxy stopped, read from its access log.
 *
 * The proxy answers a request it blocks itself, with a stub `500`, so the browser records a
 * response and nothing in the page tells a blocked request from one its host failed. The access log
 * does: a line carrying a blocking rule is a request that never left the proxy.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { normalizeRule } from '../repo/rule-normalizer';
import { parseAccessLogLine } from './adguard-cli-applied-rules';

/**
 * Line break of the access log.
 */
const LINE_BREAK = /\r?\n/u;

/**
 * Read the bytes a file gained since an offset.
 *
 * @param path - The file.
 * @param offset - Bytes already consumed.
 * @returns The new bytes; empty while the file does not exist yet.
 */
function bytesSince(path: string, offset: number): Buffer {
    let fd: number;
    try {
        fd = openSync(path, 'r');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return Buffer.alloc(0);
        }
        throw error;
    }
    try {
        const size = fstatSync(fd).size;
        if (size <= offset) {
            return Buffer.alloc(0);
        }
        const bytes = Buffer.alloc(size - offset);
        readSync(fd, bytes, 0, bytes.length, offset);
        return bytes;
    } finally {
        closeSync(fd);
    }
}

/**
 * Create the reader of one browser session's blocked requests.
 *
 * The access log has no session boundary, so a session reads only what the proxy appended after it
 * launched. The session's network log asks on every read, page-stability polling included, so each
 * call parses only the lines appended since the previous one.
 *
 * @param accessLogPath - The proxy's access log.
 * @param offset - Access-log size when the session launched.
 * @returns The URLs the proxy blocked for the session so far.
 */
export function createAdguardCliBlockedRequests(
    accessLogPath: string,
    offset: number,
): () => ReadonlySet<string> {
    const blocked = new Set<string>();
    let consumed = offset;
    // A read can end inside a multi-byte character as well as inside a line.
    const decoder = new StringDecoder('utf8');
    let partialLine = '';
    return () => {
        const bytes = bytesSince(accessLogPath, consumed);
        consumed += bytes.length;
        const lines = (partialLine + decoder.write(bytes)).split(LINE_BREAK);
        // The proxy may be midway through a line; it completes on a later read.
        partialLine = lines.pop()!;
        for (const line of lines) {
            const match = parseAccessLogLine(line);
            if (match === undefined || match.rule.length === 0 || match.handshakeBlock) {
                continue;
            }
            if (!normalizeRule(match.rule).isException) {
                blocked.add(match.url);
            }
        }
        return blocked;
    };
}

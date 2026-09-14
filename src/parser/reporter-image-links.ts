/**
 * GitHub-controlled hosts that serve reporter-uploaded issue images.
 *
 * The pair is one contract with two halves: this module accepts a link on these hosts as a reporter
 * screenshot, and the exporter in `src/local/github-issue-exporter.ts` attaches the configured read
 * token to exactly the same hosts, without which `private-user-images` serves nothing. Naming a new
 * attachment host in only one of the two places would either extract screenshots the exporter
 * cannot fetch, or hand the token to hosts extraction never yields.
 */
export const GITHUB_USER_IMAGE_HOSTS: ReadonlySet<string> = new Set([
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
]);

/**
 * Image URL paired with its source offset for stable ordering.
 */
interface IndexedReporterImage {
    /**
     * Character offset of the image reference in the source Markdown.
     */
    index: number;

    /**
     * Normalized absolute image URL.
     */
    url: string;
}

/**
 * Normalize an untrusted absolute HTTP URL without retaining a fragment.
 *
 * @param value - URL captured from reporter-authored Markdown or HTML.
 * @returns A normalized URL, or null when the captured value is invalid.
 */
function normalizeReporterImageUrl(value: string): string | null {
    try {
        const url = new URL(value.replace(/&amp;/giu, '&'));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
}

/**
 * Determine whether ordinary Markdown link text explicitly identifies a numbered screenshot.
 *
 * @param label - Visible Markdown link text.
 * @returns Whether the label is a conservative screenshot identifier.
 */
function isScreenshotLinkLabel(label: string): boolean {
    const normalized = label.replace(/[*_`]/gu, '').trim().replace(/\s+/gu, ' ');
    return /^screen[\s-]*shots?(?:\s*(?:#|no\.?\s*)?\d+)?$/iu.test(normalized);
}

/**
 * Determine whether an ordinary link target is plausibly an image rather than a web page.
 *
 * @param value - Normalized absolute URL.
 * @returns Whether the URL has an image suffix or belongs to a supported attachment namespace.
 */
function isLikelyImageDestination(value: string): boolean {
    const url = new URL(value);
    if (/\.(?:gif|jpe?g|png|webp)$/iu.test(url.pathname)) {
        return true;
    }
    const hostname = url.hostname.toLowerCase();
    if (
        (hostname === 'github.com' || hostname === 'www.github.com') &&
        url.pathname.startsWith('/user-attachments/assets/')
    ) {
        return true;
    }
    if (GITHUB_USER_IMAGE_HOSTS.has(hostname)) {
        return true;
    }
    return hostname === 'cdn.adguardcdn.com' && url.pathname.startsWith('/sitereports/');
}

/**
 * Add one normalized image match when its captured URL is valid.
 *
 * @param matches - Mutable ordered match accumulator.
 * @param index - Character offset of the source reference.
 * @param value - Captured absolute URL.
 */
function addImageMatch(matches: IndexedReporterImage[], index: number, value: string): void {
    const url = normalizeReporterImageUrl(value);
    if (url !== null) {
        matches.push({ index, url });
    }
}

/**
 * Return image matches in source order without mutating the input collection.
 *
 * Reporter issues contain only a bounded number of images, so insertion ordering avoids relying on
 * newer Array APIs that are unavailable in the project's runtime target.
 *
 * @param matches - Unordered image matches collected by syntax-specific passes.
 * @returns A new array ordered by source character offset.
 */
function orderImageMatches(matches: readonly IndexedReporterImage[]): IndexedReporterImage[] {
    const ordered: IndexedReporterImage[] = [];
    for (const match of matches) {
        const insertionIndex = ordered.findIndex((candidate) => candidate.index > match.index);
        if (insertionIndex === -1) {
            ordered.push(match);
        } else {
            ordered.splice(insertionIndex, 0, match);
        }
    }
    return ordered;
}

/**
 * Extract explicit image syntax and conservatively labelled screenshot links from reporter text.
 *
 * Ordinary Markdown links are accepted only when their label is `Screenshot` plus an optional
 * number and their destination is image-like. This preserves screenshots emitted by the AdGuard
 * reporting template without downloading article, settings, or navigation links as evidence.
 *
 * @param text - Reporter-authored Markdown or HTML.
 * @returns Unique normalized image URLs in source order.
 */
export function extractReporterImageUrls(text: string): string[] {
    const matches: IndexedReporterImage[] = [];
    const directMarkdownPattern =
        /(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+['"][^'"]*['"])?\)/giu;
    let directMarkdown: RegExpExecArray | null;
    while ((directMarkdown = directMarkdownPattern.exec(text)) !== null) {
        const explicitImage = directMarkdown[1] === '!';
        const label = directMarkdown[2] ?? '';
        const candidate = normalizeReporterImageUrl(directMarkdown[3] ?? '');
        if (
            candidate !== null &&
            (explicitImage || (isScreenshotLinkLabel(label) && isLikelyImageDestination(candidate)))
        ) {
            matches.push({ index: directMarkdown.index, url: candidate });
        }
    }

    const htmlPattern = /<img\b[^>]*\bsrc\s*=\s*['"](https?:\/\/[^'"]+)['"][^>]*>/giu;
    let htmlImage: RegExpExecArray | null;
    while ((htmlImage = htmlPattern.exec(text)) !== null) {
        addImageMatch(matches, htmlImage.index, htmlImage[1] ?? '');
    }

    const referenceDefinitions = new Map<string, string>();
    const referenceDefinitionPattern =
        /^\s*\[([^\]]+)\]:\s*<?(https?:\/\/[^>\s]+)>?(?:\s+.*)?$/gimu;
    let referenceDefinition: RegExpExecArray | null;
    while ((referenceDefinition = referenceDefinitionPattern.exec(text)) !== null) {
        const label = (referenceDefinition[1] ?? '').trim().replace(/\s+/gu, ' ').toLowerCase();
        const url = normalizeReporterImageUrl(referenceDefinition[2] ?? '');
        if (label && url !== null) {
            referenceDefinitions.set(label, url);
        }
    }

    const referencePattern = /(!?)\[([^\]]*)\]\[([^\]]*)\]/giu;
    let reference: RegExpExecArray | null;
    while ((reference = referencePattern.exec(text)) !== null) {
        const visibleLabel = reference[2] ?? '';
        const definitionLabel = (reference[3] || visibleLabel)
            .trim()
            .replace(/\s+/gu, ' ')
            .toLowerCase();
        const url = referenceDefinitions.get(definitionLabel);
        if (
            url !== undefined &&
            (reference[1] === '!' ||
                (isScreenshotLinkLabel(visibleLabel) && isLikelyImageDestination(url)))
        ) {
            matches.push({ index: reference.index, url });
        }
    }

    const bareGithubAttachmentPattern =
        /https?:\/\/(?:(?:www\.)?github\.com\/user-attachments\/assets|(?:private-)?user-images\.githubusercontent\.com)\/[^\s<>"'()[\]{}]+/giu;
    let bareAttachment: RegExpExecArray | null;
    while ((bareAttachment = bareGithubAttachmentPattern.exec(text)) !== null) {
        addImageMatch(matches, bareAttachment.index, bareAttachment[0].replace(/[.,;:!?]+$/u, ''));
    }

    const seen = new Set<string>();
    return orderImageMatches(matches)
        .map((match) => match.url)
        .filter((url) => {
            if (seen.has(url)) {
                return false;
            }
            seen.add(url);
            return true;
        });
}

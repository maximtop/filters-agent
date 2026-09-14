import { readFile } from 'node:fs/promises';
import type { ImageContent, Message } from '@earendil-works/pi-ai';

/**
 * Caller-input conversion for single-shot LLM calls: caller-authored messages to pi context parts
 * (system entries merge into the one system prompt, user entries become text or
 * text-plus-image-parts messages) and image intake (screenshot file path or in-memory bytes become
 * pi image content parts, with MIME sniffing and the vision byte cap enforced before any request
 * leaves the module). The cap and MIME classification carried over from the legacy screenshot
 * handling; owned by the input side of the single-shot mechanism so the call-path module stays
 * inside the repo's ~500-line module rule.
 */

/**
 * MIME types the image sniffer can classify; pi's openai-completions adapter sends them as
 * `image_url` data URIs.
 */
export const VisionImageMime = {
    /**
     * Portable Network Graphics.
     */
    Png: 'image/png',

    /**
     * Joint Photographic Experts Group.
     */
    Jpeg: 'image/jpeg',
} as const;

/**
 * VisionImageMime value.
 */
export type VisionImageMime = (typeof VisionImageMime)[keyof typeof VisionImageMime];

/**
 * Every VisionImageMime value, for lookups and picklists.
 */
export const VISION_IMAGE_MIME_VALUES = Object.values(VisionImageMime);

/**
 * Largest image sent to the vision model inside one request.
 *
 * Measured against the provider gateway: a 9.5 MB request succeeds while 19 MB is refused with HTTP
 * 413, so the request ceiling is about 10 MB. base64 inflates image bytes by a third, and 6 MB
 * keeps one image plus prompt text safely below the ceiling.
 */
export const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

/**
 * One image input for a single-shot message.
 */
export type SingleShotImage =
    | {
          /**
           * Screenshot file read at send time.
           */
          path: string;
      }
    | {
          /**
           * Screenshot bytes already in memory.
           */
          bytes: Uint8Array;
      };

/**
 * Roles a caller may author on a single-shot message. Assistant turns are never authored by callers
 * — the repair loop owns them internally.
 */
export const SingleShotMessageRole = {
    /**
     * System-role entry; system entries merge into the one system prompt.
     */
    System: 'system',

    /**
     * User-role entry carrying text and optional images.
     */
    User: 'user',
} as const;

/**
 * SingleShotMessageRole value.
 */
export type SingleShotMessageRole =
    (typeof SingleShotMessageRole)[keyof typeof SingleShotMessageRole];

/**
 * Every SingleShotMessageRole value, for lookups and picklists.
 */
export const SINGLE_SHOT_MESSAGE_ROLE_VALUES = Object.values(SingleShotMessageRole);

/**
 * One caller-authored single-shot message.
 */
export type SingleShotMessage =
    | {
          /**
           * System-role entry; system entries merge into the one system prompt.
           */
          role: typeof SingleShotMessageRole.System;

          /**
           * System text merged after the schema contract (structured path) or forming the system
           * prompt (text path).
           */
          text: string;
      }
    | {
          /**
           * User-role entry carrying text and optional images.
           */
          role: typeof SingleShotMessageRole.User;

          /**
           * Plain user text.
           */
          text: string;
      }
    | {
          /**
           * User-role entry carrying text and optional images.
           */
          role: typeof SingleShotMessageRole.User;

          /**
           * Plain user text; omitted when only images are sent.
           */
          text?: string;

          /**
           * Image parts attached to this user turn.
           */
          images: SingleShotImage[];
      };

/**
 * Detect the exact image MIME from magic bytes so JPEG overviews are not mislabeled as PNG.
 *
 * @param bytes - Encoded image bytes.
 * @returns JPEG MIME for a JPEG SOI marker, PNG MIME otherwise.
 */
function sniffImageMime(bytes: Uint8Array): VisionImageMime {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return VisionImageMime.Jpeg;
    }
    return VisionImageMime.Png;
}

/**
 * Materialize one caller image input into a pi image content part, enforcing the byte cap.
 *
 * Pi's openai-completions adapter sends image parts as `image_url` data URIs and drops the OpenAI
 * `detail` hint, so the `'high'`/`'low'` hints the migrated consumers used are not sent at all — an
 * accepted loss, not a gap something later fills.
 *
 * @param image - File path or in-memory bytes.
 * @returns The pi image content part.
 */
export async function toImageContent(image: SingleShotImage): Promise<ImageContent> {
    const bytes = 'path' in image ? await readFile(image.path) : image.bytes;
    if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
        throw new Error(
            `Vision image exceeds the ${MAX_VISION_IMAGE_BYTES}-byte cap ` +
                `(${bytes.byteLength} bytes)`,
        );
    }
    return {
        type: 'image',
        data: Buffer.from(bytes).toString('base64'),
        mimeType: sniffImageMime(bytes),
    };
}

/**
 * Convert caller messages into pi context parts: system texts joined in order, user messages with
 * optional image parts; each image is read and capped at that instant.
 *
 * @param messages - Caller-authored single-shot messages.
 * @returns The joined system prompt (when any) and the pi message list.
 */
export async function toPiMessages(messages: SingleShotMessage[]): Promise<{
    /**
     * Joined system prompt present when any system text was authored.
     */
    systemPrompt?: string;

    /**
     * Converted pi message list.
     */
    messages: Message[];
}> {
    const systemTexts: string[] = [];
    const converted: Message[] = [];
    for (const message of messages) {
        if (message.role === SingleShotMessageRole.System) {
            systemTexts.push(message.text);
            continue;
        }
        if (!('images' in message)) {
            converted.push({ role: 'user', content: message.text, timestamp: Date.now() });
            continue;
        }
        const parts = [
            ...(message.text !== undefined ? [{ type: 'text' as const, text: message.text }] : []),
            ...(await Promise.all(message.images.map(toImageContent))),
        ];
        converted.push({ role: 'user', content: parts, timestamp: Date.now() });
    }
    return {
        ...(systemTexts.length > 0 ? { systemPrompt: systemTexts.join('\n\n') } : {}),
        messages: converted,
    };
}

/**
 * Stream Relay — typing heartbeat + message splitting + plain sendMessage delivery.
 *
 * Consumes an AsyncIterable<string> of text chunks and delivers them to Octo
 * via plain sendMessage with intelligent splitting.
 *
 * Design constraints:
 * - Knows nothing about Claude SDK — input is a generic async text stream.
 * - All Octo API calls go through the api.ts functions (no raw fetch).
 * - Typing indicators keep the user informed while chunks accumulate.
 */

import type { ChannelType } from "./octo/types.js";
import {
  sendTyping,
  sendMessage,
} from "./octo/api.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Interval (ms) between typing indicator pings. */
const TYPING_INTERVAL_MS = 5_000;

/** Maximum characters per message segment. */
const MAX_SEGMENT_CHARS = 3_500;

// ─── Message Splitting ─────────────────────────────────────────────────────

/**
 * Split a long text into segments at natural boundaries.
 *
 * Priority: paragraph break (\n\n) > newline (\n) > space > hard cut.
 * Each segment is at most `maxChars` characters.
 */
export function splitMessage(text: string, maxChars: number = MAX_SEGMENT_CHARS): string[] {
  if (maxChars < 1) {
    throw new Error(`splitMessage: maxChars must be >= 1, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }

    const chunk = remaining.slice(0, maxChars);
    let splitAt = -1;

    // 1. Paragraph break (\n\n) — prefer the last one within range.
    const paraIdx = chunk.lastIndexOf("\n\n");
    if (paraIdx > 0) {
      splitAt = paraIdx + 2; // include the double newline in the current segment
    }

    // 2. Newline (\n)
    if (splitAt === -1) {
      const nlIdx = chunk.lastIndexOf("\n");
      if (nlIdx > 0) {
        splitAt = nlIdx + 1;
      }
    }

    // 3. Space
    if (splitAt === -1) {
      const spIdx = chunk.lastIndexOf(" ");
      if (spIdx > 0) {
        splitAt = spIdx + 1;
      }
    }

    // 4. Hard cut
    if (splitAt === -1) {
      splitAt = maxChars;
    }

    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return segments;
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

export class StreamRelay {
  /**
   * Deliver an async stream of text chunks to an Octo channel.
   *
   * 1. Starts a typing indicator heartbeat (5 s interval).
   * 2. Accumulates all chunks from the async iterable.
   * 3. Sends the accumulated text via plain sendMessage with splitting.
   * 4. Always cleans up the typing heartbeat.
   */
  async deliver(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
  ): Promise<void> {
    // --- Typing heartbeat ---
    const typingParams = { apiUrl, botToken, channelId, channelType };
    // Fire one immediately — don't wait for the first interval tick.
    sendTyping(typingParams).catch(() => {});
    const typingTimer = setInterval(() => {
      sendTyping(typingParams).catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      // Accumulate all chunks.
      let accumulated = "";
      for await (const chunk of chunks) {
        accumulated += chunk;
      }

      // Send accumulated text via plain messages with splitting.
      if (accumulated.length > 0) {
        const segments = splitMessage(accumulated);
        for (const segment of segments) {
          await sendMessage({
            apiUrl,
            botToken,
            channelId,
            channelType,
            content: segment,
          });
        }
      }
      // If accumulated is empty, the agent produced no output — nothing to send.
    } finally {
      clearInterval(typingTimer);
    }
  }
}

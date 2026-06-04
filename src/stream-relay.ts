/**
 * Stream Relay — throttled streaming output + typing heartbeat + message splitting.
 *
 * Consumes an AsyncIterable<string> of text chunks and delivers them to Octo
 * via the stream API (start/send/end). Falls back to plain sendMessage when
 * the stream API is unavailable.
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
  streamStart,
  streamSend,
  streamEnd,
} from "./octo/api.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Interval (ms) between typing indicator pings. */
const TYPING_INTERVAL_MS = 5_000;

/** Minimum interval (ms) between stream flushes. */
const FLUSH_INTERVAL_MS = 800;

/** Maximum characters per message segment when falling back to plain send. */
const MAX_SEGMENT_CHARS = 3_500;

// ─── Message Splitting ─────────────────────────────────────────────────────

/**
 * Split a long text into segments at natural boundaries.
 *
 * Priority: paragraph break (\n\n) > newline (\n) > space > hard cut.
 * Each segment is at most `maxChars` characters.
 */
export function splitMessage(text: string, maxChars: number = MAX_SEGMENT_CHARS): string[] {
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

// ─── Payload Encoding ───────────────────────────────────────────────────────

/** Encode a text message payload to base64 for the stream API. */
function encodeStreamPayload(content: string): string {
  const payload = JSON.stringify({ type: 1, content });
  return Buffer.from(payload, "utf-8").toString("base64");
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

export class StreamRelay {
  /**
   * Deliver an async stream of text chunks to an Octo channel.
   *
   * 1. Starts a typing indicator heartbeat (5 s interval).
   * 2. Attempts the stream API path (start → throttled sends → end).
   * 3. On stream API failure, falls back to plain sendMessage with splitting.
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
      await this._deliverViaStream(channelId, channelType, chunks, apiUrl, botToken);
    } finally {
      clearInterval(typingTimer);
    }
  }

  // ── Stream API path ─────────────────────────────────────────────────────

  private async _deliverViaStream(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
  ): Promise<void> {
    let accumulated = "";
    let streamNo: string | null = null;
    let lastFlushTime = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let streamFailed = false;

    // Pending flush promise so we can await the final timer-triggered flush.
    let pendingFlush: Promise<void> | null = null;

    const flush = async (): Promise<void> => {
      if (accumulated.length === 0) return;

      const payload = encodeStreamPayload(accumulated);

      try {
        if (streamNo === null) {
          // First flush — start the stream.
          streamNo = await streamStart({
            apiUrl,
            botToken,
            channelId,
            channelType,
            payload,
          });
        } else {
          await streamSend({
            apiUrl,
            botToken,
            streamNo,
            channelId,
            channelType,
            payload,
          });
        }
        lastFlushTime = Date.now();
      } catch {
        // Stream API unavailable — mark failed so we fall back after iteration.
        streamFailed = true;
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer !== null) return; // already scheduled
      const elapsed = Date.now() - lastFlushTime;
      const delay = Math.max(0, FLUSH_INTERVAL_MS - elapsed);
      flushTimer = setTimeout(() => {
        flushTimer = null;
        pendingFlush = flush();
      }, delay);
    };

    // --- Consume chunks ---
    for await (const chunk of chunks) {
      if (streamFailed) {
        // Keep accumulating for fallback delivery.
        accumulated += chunk;
        continue;
      }

      accumulated += chunk;

      const elapsed = Date.now() - lastFlushTime;
      if (elapsed >= FLUSH_INTERVAL_MS) {
        // Enough time has passed — flush immediately.
        await flush();
      } else {
        scheduleFlush();
      }
    }

    // --- Final flush ---
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Await any in-flight timer-triggered flush before the final one.
    if (pendingFlush) {
      await pendingFlush;
      pendingFlush = null;
    }

    if (streamFailed) {
      // Fallback: deliver entire accumulated text via plain messages.
      await this._deliverFallback(channelId, channelType, accumulated, apiUrl, botToken);
      return;
    }

    // Flush any remaining buffered text.
    if (accumulated.length > 0 && streamNo !== null) {
      const payload = encodeStreamPayload(accumulated);
      try {
        await streamSend({
          apiUrl,
          botToken,
          streamNo,
          channelId,
          channelType,
          payload,
        });
      } catch {
        // If the final send fails, fall back to plain messages.
        await streamEnd({ apiUrl, botToken, streamNo, channelId, channelType }).catch(() => {});
        await this._deliverFallback(channelId, channelType, accumulated, apiUrl, botToken);
        return;
      }
    }

    // End the stream.
    if (streamNo !== null) {
      await streamEnd({ apiUrl, botToken, streamNo, channelId, channelType }).catch(() => {});
    } else if (accumulated.length > 0) {
      // Never started a stream (no flush happened) — send as plain message.
      await this._deliverFallback(channelId, channelType, accumulated, apiUrl, botToken);
    }
    // If accumulated is empty and no stream started, the agent produced no output — nothing to send.
  }

  // ── Fallback: plain sendMessage with splitting ──────────────────────────

  private async _deliverFallback(
    channelId: string,
    channelType: ChannelType,
    text: string,
    apiUrl: string,
    botToken: string,
  ): Promise<void> {
    if (text.length === 0) return;

    const segments = splitMessage(text);
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
}

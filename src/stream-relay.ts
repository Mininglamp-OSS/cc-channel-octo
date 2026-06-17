/**
 * Stream Relay — incremental stream delivery + typing heartbeat + message splitting.
 *
 * Consumes an AsyncIterable<string> of text chunks and delivers them to Octo.
 *
 * Two-tier delivery (OCT-37):
 *  - **Stream path** (preferred): open a live bubble with `stream/start`, send
 *    each agent chunk via `sendMessage({ stream_no, content })`, and always
 *    close it with `stream/end` in a `finally` so the terminal END fires even
 *    on agent error / abort / truncation. octo-web (OCT-11) stops the streaming
 *    bubble on that END; a missing END leaves it stuck "streaming".
 *  - **Fallback path**: when the server does not advertise the stream routes
 *    (404 on `stream/start`), deliver the accumulated text via plain
 *    `sendMessage` with @mention resolution + intelligent splitting. The 404
 *    is a capability signal, NOT a turn error.
 *
 * Design constraints:
 * - Knows nothing about Claude SDK — input is a generic async text stream.
 * - All Octo API calls go through the api.ts functions (no raw fetch).
 * - Typing indicators keep the user informed while chunks flow.
 *
 * NOTE: the stream path streams raw chunks for the live token-by-token bubble
 * and does NOT resolve @mentions (mentions can span chunk boundaries, and
 * per-chunk entity offsets do not map onto octo-web's concatenated bubble).
 * Full @mention resolution + notification routing happens on the fallback
 * path. See OCT-37 follow-up for streamed-bubble mention handling.
 */

import type { ChannelType } from "./octo/types.js";
import {
  sendTyping,
  sendMessage,
  streamStart,
  streamEnd,
} from "./octo/api.js";
import { resolveMentions } from "./mention-utils.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Interval (ms) between typing indicator pings. */
const TYPING_INTERVAL_MS = 5_000;

/** Maximum characters per message segment. */
const MAX_SEGMENT_CHARS = 3_500;

/** Default maximum accumulated response length before truncation (Q32). */
const DEFAULT_MAX_RESPONSE_CHARS = 524_288; // 512 KB

/** Truncation suffix appended when response exceeds limit. */
const TRUNCATION_SUFFIX = '\n\n[response truncated]';

// ─── Message Splitting ─────────────────────────────────────────────────────

/** A protected range that splitMessage must not cut through. */
export interface ProtectedRange {
  /** Start offset (inclusive, UTF-16 code units). */
  start: number;
  /** End offset (exclusive). */
  end: number;
}

/**
 * Adjust a candidate split position so it does not fall strictly inside any
 * protected range. If splitAt lands inside [start, end), prefer pushing back
 * to `start` (move the protected unit whole to the next segment).
 *
 * Returns the adjusted split position, or null if pulling back would land at 0.
 */
function adjustSplitForProtectedRanges(
  splitAt: number,
  protectedRanges: ProtectedRange[],
): number | null {
  for (const range of protectedRanges) {
    if (splitAt > range.start && splitAt < range.end) {
      // Pull BACK to range.start so the protected unit moves whole to next seg.
      if (range.start > 0) return range.start;
      // Range starts at 0 — can't pull back. Caller will deal.
      return null;
    }
  }
  return splitAt;
}

/**
 * Split a long text into segments at natural boundaries.
 *
 * Priority: paragraph break (\n\n) > newline (\n) > space > hard cut.
 * Each segment is at most `maxChars` characters.
 *
 * `protectedRanges` (P0-1): byte ranges that must NOT be split through. Used
 * by deliver() to keep resolved @name mentions intact — a name like
 * "@John Smith Junior" must be sent as one unit so the corresponding
 * MentionEntity offset/length lands cleanly in one segment.
 */
export function splitMessage(
  text: string,
  maxChars: number = MAX_SEGMENT_CHARS,
  protectedRanges: ProtectedRange[] = [],
): string[] {
  if (maxChars < 1) {
    throw new Error(`splitMessage: maxChars must be >= 1, got ${maxChars}`);
  }
  if (text.length <= maxChars) return [text];

  const segments: string[] = [];
  let remaining = text;
  let consumed = 0;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      segments.push(remaining);
      break;
    }

    const chunk = remaining.slice(0, maxChars);
    // Translate global ranges to local offsets relative to remaining.
    const localRanges = protectedRanges
      .filter(r => r.end > consumed && r.start < consumed + remaining.length)
      .map(r => ({ start: r.start - consumed, end: r.end - consumed }));

    let splitAt = -1;
    function tryCandidate(candidate: number): boolean {
      const adj = adjustSplitForProtectedRanges(candidate, localRanges);
      if (adj === null || adj <= 0 || adj > maxChars) return false;
      splitAt = adj;
      return true;
    }

    // 1. Paragraph break (\n\n) — prefer the last one within range.
    const paraIdx = chunk.lastIndexOf("\n\n");
    if (paraIdx > 0) tryCandidate(paraIdx + 2);

    // 2. Newline (\n)
    if (splitAt === -1) {
      const nlIdx = chunk.lastIndexOf("\n");
      if (nlIdx > 0) tryCandidate(nlIdx + 1);
    }

    // 3. Space
    if (splitAt === -1) {
      const spIdx = chunk.lastIndexOf(" ");
      if (spIdx > 0) tryCandidate(spIdx + 1);
    }

    // 4. Hard cut — avoid splitting surrogate pairs AND protected ranges.
    if (splitAt === -1) {
      splitAt = maxChars;
      // If the cut falls between a surrogate pair, back up one code unit.
      const code = remaining.charCodeAt(splitAt - 1);
      if (code >= 0xD800 && code <= 0xDBFF) splitAt--;
      // If the cut falls inside a protected range, pull back to its start.
      // Pathological case (range starts at 0 and exceeds maxChars): we fall
      // back to maxChars and accept the broken mention rather than infinite
      // loop. In practice an @[uid:name] is far shorter than maxChars=3500.
      const adj = adjustSplitForProtectedRanges(splitAt, localRanges);
      if (adj !== null && adj > 0) splitAt = Math.min(adj, maxChars);
    }

    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    consumed += splitAt;
  }

  return segments;
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

export class StreamRelay {
  /**
   * Cached stream-route capability. `undefined` = not yet probed, `true` =
   * stream routes available, `false` = server returned 404 on stream/start
   * (don't probe again — go straight to the fallback path every turn).
   */
  private streamRoutesAvailable?: boolean;

  /**
   * Deliver an async stream of text chunks to an Octo channel.
   *
   * 1. Starts a typing indicator heartbeat (5 s interval).
   * 2. Attempts the incremental stream path (start → per-chunk send → end).
   * 3. If the server does not advertise stream routes (404 on start), falls
   *    back to the plain accumulate → resolve mentions → split → send path.
   * 4. Always cleans up the typing heartbeat.
   */
  async deliver(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
    maxResponseChars: number = DEFAULT_MAX_RESPONSE_CHARS,
    memberMap?: Map<string, string>,
    isValidUid?: (uid: string) => boolean,
  ): Promise<void> {
    // --- Typing heartbeat ---
    const typingParams = { apiUrl, botToken, channelId, channelType };
    // Fire one immediately — don't wait for the first interval tick.
    sendTyping(typingParams).catch(() => {});
    const typingTimer = setInterval(() => {
      sendTyping(typingParams).catch(() => {});
    }, TYPING_INTERVAL_MS);

    try {
      // Attempt the stream path unless we already know the routes are absent.
      if (this.streamRoutesAvailable !== false) {
        const handled = await this._deliverViaStream(
          channelId,
          channelType,
          chunks,
          apiUrl,
          botToken,
          maxResponseChars,
        );
        // handled === false ONLY when stream/start failed BEFORE any chunk was
        // consumed, so `chunks` is still pristine for the fallback path.
        if (handled) return;
      }
      await this._deliverPlain(
        channelId,
        channelType,
        chunks,
        apiUrl,
        botToken,
        maxResponseChars,
        memberMap,
        isValidUid,
      );
    } finally {
      clearInterval(typingTimer);
    }
  }

  // ── Stream path (OCT-37) ─────────────────────────────────────────────────

  /**
   * Open a stream, send each chunk as an incremental message, and ALWAYS close
   * the stream with a terminal END (in a finally) so octo-web stops the live
   * bubble even on agent error / abort / truncation.
   *
   * Returns `true` when the stream path handled delivery (including when the
   * agent produced no output after a successful start). Returns `false` only
   * when stream/start failed before consuming any chunk — the caller then runs
   * the fallback path on the still-untouched `chunks`.
   *
   * Re-throws a source-iterable error after END fires, mirroring the plain
   * path, so the caller's error handling still runs. Per-chunk send failures
   * are swallowed (logged) so one bad chunk does not abort the stream.
   */
  private async _deliverViaStream(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
    maxResponseChars: number,
  ): Promise<boolean> {
    let streamNo: string;
    try {
      const res = await streamStart({ apiUrl, botToken, channelId, channelType });
      streamNo = res.stream_no;
    } catch (err) {
      // Capability detection by HTTP status (duck-typed via OctoApiError.status)
      // — robust to cross-module instanceof and to test mocks.
      const status = (err as { status?: number })?.status;
      if (status === 404) {
        // Server does not advertise the stream routes — remember and fall back.
        this.streamRoutesAvailable = false;
        return false;
      }
      // Transient start failure (5xx, network). Don't disable streaming
      // permanently; fall back for this turn so the reply is not dropped.
      console.error(`[stream-relay] stream/start failed, falling back to plain send: ${String(err)}`);
      return false;
    }
    this.streamRoutesAvailable = true;

    let streamError: unknown;
    let accumulatedLen = 0;
    try {
      let truncated = false;
      for await (const chunk of chunks) {
        if (truncated) break;
        let piece = chunk;
        // Q32: bound total streamed length; cut the chunk that crosses the limit.
        if (accumulatedLen + piece.length > maxResponseChars) {
          let cutAt = maxResponseChars - accumulatedLen;
          if (cutAt > 0) {
            // P1-6: don't cut inside a surrogate pair.
            const code = piece.charCodeAt(cutAt - 1);
            if (code >= 0xd800 && code <= 0xdbff) cutAt--;
          }
          piece = piece.slice(0, Math.max(0, cutAt)) + TRUNCATION_SUFFIX;
          truncated = true;
        }
        accumulatedLen += piece.length;
        if (piece.length > 0) {
          try {
            await sendMessage({ apiUrl, botToken, channelId, channelType, streamNo, content: piece });
          } catch (err) {
            console.error(`[stream-relay] stream chunk send failed (${piece.length} chars), continuing: ${String(err)}`);
          }
        }
      }
      if (truncated) {
        console.warn(`[stream-relay] Response truncated at ${maxResponseChars} chars`);
      }
    } catch (err) {
      streamError = err;
      console.error(`[stream-relay] agent stream threw mid-stream after ${accumulatedLen} char(s); emitting terminal END: ${String(err)}`);
    } finally {
      // ALWAYS emit the terminal END so the live bubble is closed — even on
      // agent error / abort / truncation. Swallow END failures (best-effort).
      try {
        await streamEnd({ apiUrl, botToken, streamNo, channelId, channelType });
      } catch (err) {
        console.error(`[stream-relay] stream/end failed: ${String(err)}`);
      }
    }

    // Surface the source error after END so the caller's error path still runs.
    if (streamError !== undefined) throw streamError;
    return true;
  }

  // ── Fallback path: accumulate → resolve mentions → split → plain send ─────

  private async _deliverPlain(
    channelId: string,
    channelType: ChannelType,
    chunks: AsyncIterable<string>,
    apiUrl: string,
    botToken: string,
    maxResponseChars: number,
    memberMap?: Map<string, string>,
    isValidUid?: (uid: string) => boolean,
  ): Promise<void> {
    // Accumulate all chunks, with truncation guard (Q32).
    let accumulated = "";
    let truncated = false;
    // If the agent stream throws mid-way (network blip, non-recoverable SDK
    // error after partial output), we still want to deliver what we have
    // instead of dropping a real partial reply on the floor — then re-throw so
    // the caller's error path still runs. Capture the error and flush below.
    let streamError: unknown;
    try {
      for await (const chunk of chunks) {
        accumulated += chunk;
        // Q32: Stop accumulating once limit is reached to prevent unbounded memory.
        if (accumulated.length > maxResponseChars) {
          // P1-6: cut at code-unit boundary, but back off if it lands inside
          // a surrogate pair (would produce an orphan high surrogate = invalid
          // Unicode). Mirrors splitMessage's hard-cut surrogate guard.
          let cutAt = maxResponseChars;
          const code = accumulated.charCodeAt(cutAt - 1);
          if (code >= 0xD800 && code <= 0xDBFF) cutAt--;
          accumulated = accumulated.slice(0, cutAt) + TRUNCATION_SUFFIX;
          truncated = true;
          break;
        }
      }
    } catch (err) {
      streamError = err;
      console.error(`[stream-relay] agent stream threw after ${accumulated.length} char(s); flushing partial output: ${String(err)}`);
    }
    if (truncated) {
      console.warn(`[stream-relay] Response truncated at ${maxResponseChars} chars`);
    }

    // Send accumulated text via plain messages with splitting.
    if (accumulated.length > 0) {
      // P0-1: Resolve @[uid:name] structured mentions and @name ONCE on the
      // full accumulated text, BEFORE splitting. This guarantees splitMessage
      // cannot break a structured mention across segments — by the time
      // splitMessage runs, @[uid:name] is already @name. We additionally
      // pass each resolved @name as a ProtectedRange so splitMessage avoids
      // cutting through names that contain spaces (e.g. "John Smith").
      const {
        finalContent,
        mentionEntities: globalEntities,
        mentionAll,
      } = resolveMentions(accumulated, memberMap, isValidUid);

      const protectedRanges = globalEntities.map(e => ({
        start: e.offset,
        end: e.offset + e.length,
      }));

      const segments = splitMessage(finalContent, undefined, protectedRanges);
      let segStart = 0;
      let mentionAllConsumed = false;
      for (const segment of segments) {
        const segEnd = segStart + segment.length;
        // Partition entities falling within this segment, re-rebase to
        // segment-local offsets. Server expects per-message offsets.
        const segEntities = globalEntities
          .filter(e => e.offset >= segStart && e.offset + e.length <= segEnd)
          .map(e => ({ uid: e.uid, offset: e.offset - segStart, length: e.length }));
        const segUids = segEntities.map(e => e.uid);

        // mentionAll only applies to one segment (the first). Avoids spamming
        // @所有人 notifications when a reply spans multiple chunks.
        //
        // Design choice (王大锤 PR#45 review note): we attach mentionAll to the
        // FIRST segment unconditionally, not to the segment that actually
        // contains the resolved "@all"/"@所有人" text. Three reasons:
        //   1. mentionAll on the Octo API is a wire-level notification flag,
        //      independent of where the literal "@all" text appears.
        //   2. The first segment is always sent first — attaching the flag
        //      there minimizes notification latency.
        //   3. The literal text may have been resolved/rewritten by the LLM
        //      into multiple positions; pinning to segment 0 is unambiguous.
        // Alternative considered: scan each segment for @all literal and
        // attach the flag only to segments containing it. Rejected because
        // it would double-notify when @all appears more than once.
        const useMentionAll = mentionAll && !mentionAllConsumed;
        if (useMentionAll) mentionAllConsumed = true;

        try {
          await sendMessage({
            apiUrl,
            botToken,
            channelId,
            channelType,
            content: segment,
            ...(segUids.length > 0 ? { mentionUids: segUids } : {}),
            ...(segEntities.length > 0 ? { mentionEntities: segEntities } : {}),
            ...(useMentionAll ? { mentionAll: true } : {}),
          });
        } catch (err) {
          console.error(`[stream-relay] sendMessage failed for segment (${segment.length} chars), continuing: ${String(err)}`);
          // Continue sending remaining segments — don't let one failure drop the rest
        }
        segStart = segEnd;
      }
    }
    // If accumulated is empty, the agent produced no output — nothing to send.
    // If the stream threw mid-way, we've now flushed whatever partial text was
    // accumulated; re-throw so the caller's error handling still runs (it will
    // not double-send — the partial was delivered here, the caller only logs /
    // surfaces the failure).
    if (streamError !== undefined) throw streamError;
  }
}

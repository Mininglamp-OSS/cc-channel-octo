/**
 * cc-channel-octo — Entry point.
 * Bridge Claude Code (via Claude Agent SDK) to Octo IM.
 *
 * Orchestrates: loadConfig → createAdapter → SessionStore.init →
 * OctoGateway.start → setMessageHandler wiring the full pipeline.
 */

import { loadConfig } from './config.js';
import { createAdapter } from './db-adapter.js';
import { SessionStore } from './session-store.js';
import { OctoGateway } from './gateway.js';
import { SessionRouter } from './session-router.js';
import { GroupContext } from './group-context.js';
import { queryAgent, sanitizeForSystemPrompt } from './agent-bridge.js';
import type { SessionCtx } from './cwd-resolver.js';
import { cleanupExpiredCwds } from './cwd-resolver.js';
import { StreamRelay } from './stream-relay.js';
import { sendMessage, sendReadReceipt, getChannelMessages } from './octo/api.js';
import type { HistoricalMessage } from './octo/api.js';
import { ChannelType, MessageType } from './octo/types.js';
import type { BotMessage } from './octo/types.js';
import { resolveContent, tryResolveFile, resolveHistoricalMessagePlaceholder } from './inbound.js';
import { buildInlinedFileBody, truncateUtf8ByBytes } from './file-inline-wrap.js';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

async function main(): Promise<void> {
  // --- Q8: Global unhandled rejection handler ---
  process.on('unhandledRejection', (reason) => {
    console.error('[cc-channel-octo] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });

  // --- Config ---
  const config = loadConfig();
  // Q3: loadConfig() always populates cwdBase from defaults; the `?? cwd`
  // fallback is only here for hand-built Config objects in tests/imports.
  const cwdBase = config.cwdBase ?? config.cwd;
  console.log(
    `[cc-channel-octo] Config loaded: apiUrl=${config.apiUrl}, cwdBase=${cwdBase}, ` +
    `dataDir=${config.dataDir}, sdk.model=${config.sdk.model ?? 'default'}, ` +
    `sdk.allowedTools=${config.sdk.allowedTools === '*' ? '*' : `[${config.sdk.allowedTools.join(',')}]`}, ` +
    `sdk.permissionMode=${config.sdk.permissionMode}, ` +
    `rateLimit=${config.rateLimit.maxPerMinute} req/min, ` +
    `context.maxContextChars=${config.context.maxContextChars}, ` +
    `context.historyLimit=${config.context.historyLimit}`,
  );

  // --- Q3: per-session cwd cleanup (7d TTL) ---
  cleanupExpiredCwds(cwdBase);
  const CWD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const cwdCleanupTimer = setInterval(() => {
    cleanupExpiredCwds(cwdBase);
  }, CWD_CLEANUP_INTERVAL_MS);
  // Allow the process to exit cleanly even if this timer is the only thing
  // keeping the event loop alive (e.g. tests, single-shot smoke runs).
  cwdCleanupTimer.unref();

  // --- Database ---
  const dbPath = join(config.dataDir, 'cc-octo.db');
  const adapter = createAdapter(dbPath);
  const store = new SessionStore(adapter);
  store.init();

  // Clean expired sessions on startup
  const cleaned = store.cleanExpired();
  if (cleaned > 0) {
    console.log(`[cc-channel-octo] Cleaned ${cleaned} expired session(s)`);
  }

  // --- Group context ---
  const groupContext = new GroupContext(adapter, config.context.maxContextChars);
  groupContext.loadAllFromDb();

  // --- Stream relay ---
  const streamRelay = new StreamRelay();

  // --- Gateway ---
  const gateway = new OctoGateway(config);
  await gateway.start();

  console.log(`[cc-channel-octo] Bot started: id=${gateway.botId}`);

  // --- Session router ---
  const router = new SessionRouter(config, gateway.botId, gateway.ownerUid);

  // --- Active handler tracking (Q6: in-flight drain on shutdown) ---
  const activeHandlers = new Set<Promise<void>>();

  // --- Message handler ---
  gateway.setMessageHandler((msg: BotMessage) => {
    if (gateway.draining) return; // Extra guard: drop during shutdown
    const p = handleMessage(msg, config, store, router, groupContext, streamRelay, gateway.botId)
      .catch((err) => {
        // Q8: catch unhandled rejections from fire-and-forget handlers
        console.error('[cc-channel-octo] Unhandled message handler error:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        activeHandlers.delete(p);
      });
    activeHandlers.add(p);
  });

  // --- Q6 + Q7: Shutdown callback (drain handlers + close store) ---
  gateway.setShutdownCallback(async () => {
    clearInterval(cwdCleanupTimer); // Q3: stop the periodic cwd cleanup
    await gateway.stop(activeHandlers);
    store.close(); // Q7: explicitly close SQLite (WAL checkpoint)
  });

  console.log('[cc-channel-octo] Ready — listening for messages');
}

async function handleMessage(
  msg: BotMessage,
  config: ReturnType<typeof loadConfig>,
  store: SessionStore,
  router: SessionRouter,
  groupContext: GroupContext,
  streamRelay: StreamRelay,
  botId: string,
): Promise<void> {
  const channelId = msg.channel_id ?? '';
  const channelType = msg.channel_type ?? ChannelType.DM;
  const isGroup = channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;

  // --- Route + pipeline under single session lock (no gap between route and processing) ---
  // For non-processed messages, routeAndHandle returns without calling handler.
  // We still need to cache group text messages for context.
  let wasProcessed = false;
  const routeResult = await router.routeAndHandle(msg, async (result) => {
    wasProcessed = true;
    const { sessionKey } = result;

    try {
      // --- Session ---
      store.getOrCreate(sessionKey, channelId, channelType);

      // --- Group context: refresh members + build context string ---
      let contextStr = '';
      if (isGroup) {
        await groupContext.refreshMembers(channelId, config.apiUrl, config.botToken);
        contextStr = groupContext.buildContext(channelId);
        // Cache current message AFTER buildContext so it only appears in
        // [Current message], not duplicated in [Group context]. We render
        // a short summary for non-text payloads so context still shows them.
        const contextSummary = renderMessageForContext(msg, config.apiUrl);
        if (contextSummary) {
          groupContext.pushMessage(
            channelId,
            msg.from_uid,
            msg.from_name ?? msg.from_uid,
            contextSummary,
            msg.timestamp,
          );
        }
      }

      // --- G1: Resolve the inbound payload into LLM-friendly text ---
      // Text messages use the router's cleanContent (with @bot stripping);
      // non-text payloads go through resolveContent for type-aware rendering.
      const resolved = resolveContent(msg.payload, config.apiUrl);
      let bodyText = result.cleanContent ?? resolved.text;

      // Compact history record. For File payloads we store only the metadata
      // line (not the inlined contents) so a user dropping a few text files
      // can't blow up the system prompt on subsequent turns. See PR#33
      // follow-up issue ·2 (齐哥 review).
      let historyRecord = bodyText;

      // G2: Inline text-file content for File payloads when feasible.
      if (
        msg.payload.type === MessageType.File &&
        resolved.mediaUrl
      ) {
        const filename = typeof msg.payload.name === 'string' ? msg.payload.name : '未知文件';
        const knownSize = typeof msg.payload.size === 'number' ? msg.payload.size : undefined;
        // Always store just the [文件: name] metadata in history — the
        // inlined contents go to the LLM for THIS turn only.
        historyRecord = `[文件: ${filename}]`;
        try {
          const fileResult = await tryResolveFile({
            url: resolved.mediaUrl,
            botToken: config.botToken,
            apiUrl: config.apiUrl,
            filename,
            knownSize,
          });
          if ('inlined' in fileResult) {
            // S2: wrap user-controlled file content in base64-encoded
            // <file_content> tag to prevent prompt injection via forged
            // close-delimiter. SECURITY_PROMPT_PREFIX explains to the LLM
            // that decoded content remains untrusted.
            bodyText = buildInlinedFileBody(filename, fileResult.inlined);
          } else if ('tempPath' in fileResult) {
            bodyText = `[文件: ${filename}]\n本地路径: ${fileResult.tempPath}\n远程 URL: ${resolved.mediaUrl}`;
          } else {
            bodyText = fileResult.description;
          }
        } catch (err) {
          console.error(`[cc-channel-octo] inline file failed: ${String(err)}`);
          // Keep the default bodyText from resolveContent.
        }
      }

      // --- Build history prefix BEFORE appending current message (G10: segmented) ---
      // Use historyRecord (metadata-only for files) instead of bodyText to keep
      // SQLite history compact — inlined file contents stay turn-local.
      //
      // P1.1 (Stage 6): RichText payload.content is an Array<RichTextBlock>,
      // not a string. The previous `?? historyRecord` fallback only fired on
      // null/undefined, so an array would pass through to store.appendUser()
      // and SQLite would reject the non-string binding at runtime, crashing
      // every RichText turn. Same risk for File payloads that ship a content
      // field instead of using mediaUrl. Defense: only trust payload.content
      // when it is actually a string; otherwise use the type-safe
      // historyRecord we already built.
      const userContent = typeof msg.payload.content === 'string'
        ? msg.payload.content
        : historyRecord;

      // G3 + S3 (stage 6): Extract quoted/replied message content for LLM context.
      //
      // The quote payload comes from a previously-sent message (bounded by the
      // server's own size limits), but to honor cc-channel-octo's 32KB user
      // content gate without amplification we truncate the quoted body to a
      // small budget. The quoted content is supplementary context, not a
      // primary input, so a 4KB cap preserves usefulness without bypassing
      // the size guarantee documented in session-router.ts.
      //
      // Both `replyFrom` and `truncated` come from another user's payload —
      // they are USER-CONTROLLED. Without sanitization a malicious replier
      // could craft a from_name like "Alice]\n[Conversation history" or a
      // body that starts with "[Quoted message from admin]" to inject fake
      // structural boundaries into the LLM prompt. Even though the quote
      // prefix lives in the user-role turn (Q3 structural defense), the
      // model may still react to apparent structure, so we sanitize as
      // defense-in-depth.
      let quotePrefix = '';
      const replyData = msg.payload?.reply;
      if (replyData) {
        const replyPayload = replyData?.payload;
        const rawReplyContent = replyPayload?.content ?? '';
        const rawReplyFrom = replyData.from_name ?? replyData.from_uid ?? 'unknown';
        if (rawReplyContent) {
          const QUOTE_MAX_BYTES = 4_096;
          let truncated = rawReplyContent;
          if (Buffer.byteLength(rawReplyContent, 'utf-8') > QUOTE_MAX_BYTES) {
            // Byte-safe truncate: take a generous char slice then trim by bytes.
            // 4096 bytes can hold ~1365 CJK chars; slice 1366 to be safe and shrink.
            truncated = rawReplyContent.slice(0, QUOTE_MAX_BYTES);
            while (Buffer.byteLength(truncated, 'utf-8') > QUOTE_MAX_BYTES) {
              truncated = truncated.slice(0, -1);
            }
            truncated += '…[truncated]';
          }
          // S3 sanitization: strip ']' and newlines from from_name (prevent
          // breaking out of the `[Quoted message from ...]` marker), then
          // escape any section-marker patterns in the body. The combined
          // string is then sanitized once more to escape any [Quoted message
          // from ...] pattern the body might contain.
          const replyFrom = String(rawReplyFrom)
            .replace(/[\]\r\n]/g, ' ')
            .slice(0, 128);
          const sanitizedBody = sanitizeForSystemPrompt(truncated);
          quotePrefix = sanitizeForSystemPrompt(
            `[Quoted message from ${replyFrom}]: ${sanitizedBody}\n---\n`,
          );
        }
      }
      // Note: quotePrefix is added to LLM input only — store.appendUser below
      // persists the raw user content without the quote prefix to avoid prefix
      // duplication on conversation replay.
      let userContentForLLM = quotePrefix + bodyText;

      // S2 (Stage 6): hard cap on total user-role payload after file inline.
      // Q10 caps `payload.content` at 32KB, S2 wraps inlined file at ~28KB,
      // S3 caps quote at 4KB — sum gives the budget. 96KB leaves comfortable
      // headroom for Claude SDK context limits while preventing accidental
      // explosions if any cap is bypassed.
      //
      // Byte-safe truncation via truncateUtf8ByBytes (Q静春 PR#40 review nit):
      // String.prototype.slice operates on UTF-16 code units, so a CJK-heavy
      // payload would not actually be capped at 96KB. The helper trims to a
      // valid UTF-8 boundary so we never emit a replacement char.
      const MAX_USER_LLM_BYTES = 98_304; // 96 KB
      const { truncated, wasTruncated } = truncateUtf8ByBytes(userContentForLLM, MAX_USER_LLM_BYTES);
      if (wasTruncated) {
        userContentForLLM = truncated + '\n[… user input truncated to 96KB cap]';
      }

      // G4: Backfill history from API when local cache is empty for groups.
      // Only triggered on first interaction with a group (cold start) to avoid
      // duplicate API calls; checked via a sentinel marker stored in-memory.
      let historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
      if (
        isGroup &&
        !historyPrefix &&
        !backfilledSessions.has(sessionKey) &&
        msg.channel_id &&
        msg.channel_type !== undefined
      ) {
        backfilledSessions.add(sessionKey);
        try {
          const apiMessages = await getChannelMessages({
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId: msg.channel_id,
            channelType: msg.channel_type,
            limit: Math.min(config.context.historyLimit, 100),
          });
          if (apiMessages.length > 0) {
            // Persist into local store so subsequent turns hit cache,
            // and rebuild historyPrefix with the enriched data. Pass the
            // bot's own uid so its prior replies are stored as assistant
            // turns (PR#33 follow-up: previously every backfilled message
            // was stored as user, which made the LLM see its own past words
            // as if the user had said them).
            seedHistoryFromApi(store, sessionKey, apiMessages, botId);
            historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
          }
        } catch (err) {
          console.error(`[cc-channel-octo] G4 backfill failed for ${sessionKey}: ${String(err)}`);
        }
      }

      store.appendUser(sessionKey, userContent, msg.message_seq);

      // --- Query agent with structural role separation (Q3 fix) ---
      // userContentForLLM → user role (prompt), history + context → system role (systemPrompt)
      // Q3 cwd isolation: derive a per-session SessionCtx from channel_type
      // so resolveSessionCwd can hash to a stable hex subdir under cwdBase.
      // DM keys on the sender uid plus optional spaceId; groups key on channel_id
      // (everyone in the room shares the same workspace, matching IM mental
      // model — a group's "project" is collective). Thread routing is reserved
      // until BotMessage exposes thread/topic metadata.
      //
      // P0-2: SessionRouter.sessionKey() scopes DMs by spaceId when present
      // (`${spaceId}:${from_uid}`), so the cwd partition must match — the same
      // uid in two spaces has two histories and therefore needs two sandboxes.
      // We recover spaceId from the router-produced sessionKey itself (rather
      // than re-deriving it) so the two can never drift out of sync.
      const sessionCtx: SessionCtx = isGroup
        ? { kind: 'group', groupId: channelId }
        : { kind: 'dm', userId: msg.from_uid, spaceId: dmSpaceIdFromKey(sessionKey, msg.from_uid) };
      const rawChunks = queryAgent(userContentForLLM, historyPrefix, contextStr, config, sessionCtx);

      // Tee the generator: collect full text while streaming to Octo
      const collected: string[] = [];
      async function* teeChunks(): AsyncIterable<string> {
        for await (const chunk of rawChunks) {
          collected.push(chunk);
          yield chunk;
        }
      }

      // --- Stream output to Octo ---
      await streamRelay.deliver(channelId, channelType, teeChunks(), config.apiUrl, config.botToken, config.maxResponseChars);

      // G8: Send read receipt after processing (fire-and-forget)
      if (msg.message_id && msg.channel_id && msg.channel_type !== undefined) {
        sendReadReceipt({
          apiUrl: config.apiUrl,
          botToken: config.botToken,
          channelId: msg.channel_id,
          channelType: msg.channel_type,
          messageIds: [msg.message_id],
        }).catch((err) => console.error(`[cc-channel-octo] readReceipt failed: ${String(err)}`));
      }

      // --- Store assistant response in history ---
      const fullResponse = collected.join('');
      if (fullResponse) {
        store.appendAssistant(sessionKey, fullResponse, msg.message_seq);
        // G10: mark this message_seq as the last one we replied to. Next turn's
        // segmented history will treat messages with seq <= this as [answered].
        store.setLastBotReplySeq(sessionKey, msg.message_seq);
      } else {
        // Agent produced no output — send a feedback message so user isn't left hanging
        await sendMessage({
          apiUrl: config.apiUrl,
          botToken: config.botToken,
          channelId,
          channelType,
          content: '[No response generated. Please try rephrasing your question.]',
        });
      }

    } catch (err) {
      console.error(`[cc-channel-octo] Error processing message (session=${result.sessionKey}):`, String(err));
      // Best-effort error reply
      try {
        await sendMessage({
          apiUrl: config.apiUrl,
          botToken: config.botToken,
          channelId,
          channelType,
          content: 'An error occurred while processing your message. Please try again.',
        });
      } catch {
        /* swallow — don't crash on reply failure */
      }
    }
  });

  // Cache non-processed group messages for context.
  // G21: skip stream update messages — only cache the final (non-stream) message.
  // G1: cache non-text payloads as type summaries so [Group context] shows them.
  //
  // C1 / P2.5 (Stage 6): do NOT cache messages that the router actively
  // rejected (rate-limited, oversized). Without this guard a flooder who
  // tripped the rate limit could still inject text the LLM would see on the
  // next legitimate turn — the rate limit reply went out but the content
  // still landed in [Group context]. Silently-dropped messages (not_mentioned,
  // system_event, bot loop) still cache because they are legitimate group
  // chatter the agent should be aware of when next addressed.
  const SUPPRESS_GROUP_CACHE = new Set(['rate_limited', 'oversized']);
  const suppressGroupCache =
    !!routeResult?.rejectionReason && SUPPRESS_GROUP_CACHE.has(routeResult.rejectionReason);

  if (!wasProcessed && isGroup && !msg.streamOn && !suppressGroupCache) {
    const summary = renderMessageForContext(msg, config.apiUrl);
    if (summary) {
      groupContext.pushMessage(
        channelId,
        msg.from_uid,
        msg.from_name ?? msg.from_uid,
        summary,
        msg.timestamp,
      );
    }
  }
}

// ─── G1/G11 helpers ───────────────────────────────────────────────────────────────────

/**
 * P0-2: Recover the DM spaceId from the router-produced sessionKey.
 *
 * SessionRouter.sessionKey() builds DM keys as `${spaceId}:${from_uid}` when a
 * space is known, or bare `from_uid` otherwise. We invert that here so the cwd
 * sandbox partition stays byte-for-byte consistent with the history partition,
 * instead of re-deriving spaceId via a parallel extractor that could drift.
 *
 * Returns the spaceId, or undefined when the key is the bare uid (no space).
 */
function dmSpaceIdFromKey(sessionKey: string, fromUid: string): string | undefined {
  const suffix = `:${fromUid}`;
  if (sessionKey.endsWith(suffix) && sessionKey.length > suffix.length) {
    return sessionKey.slice(0, -suffix.length);
  }
  return undefined;
}

/**
 * Compact rendering of a message for the rolling [Group context] cache.
 *
 * Text → raw content (cheap, faithful).
 * Non-text → short placeholder via resolveContent so the agent at least
 * sees "某人: [图片]" instead of nothing.
 */
function renderMessageForContext(msg: BotMessage, apiUrl: string): string {
  if (msg.payload.type === MessageType.Text) {
    return msg.payload.content ?? '';
  }
  // For non-text use the resolved text (already short for media/cards).
  const resolved = resolveContent(msg.payload, apiUrl);
  return resolved.text;
}

/** Sessions for which G4 cold-start backfill has already run. */
const backfilledSessions = new Set<string>();

/**
 * Seed local SessionStore with messages fetched from the WuKongIM sync API.
 *
 * Messages authored by the bot itself (from_uid === botId) are stored as
 * assistant turns so the LLM sees its own past replies labeled `[assistant]:`
 * — otherwise the LLM later reads its own words as if a user said them
 * (PR#33 follow-up: 齐哥 review).
 *
 * Messages are persisted in chronological order so segmentation by
 * message_seq remains consistent across the cache + backfill boundary.
 */
function seedHistoryFromApi(
  store: SessionStore,
  sessionKey: string,
  apiMessages: HistoricalMessage[],
  botId: string,
): void {
  // Older messages first — sync API returns newest-first depending on pull_mode.
  const ordered = apiMessages
    .slice()
    .sort((a, b) => (a.message_seq ?? 0) - (b.message_seq ?? 0));
  for (const m of ordered) {
    const placeholder = resolveHistoricalMessagePlaceholder(m.type, m.name);
    const content = m.content && m.content.trim() !== ''
      ? m.content
      : placeholder;
    if (!content) continue;
    if (botId && m.from_uid === botId) {
      store.appendAssistant(sessionKey, content, m.message_seq);
    } else {
      store.appendUser(sessionKey, content, m.message_seq);
    }
  }
}

main().catch((err) => {
  console.error('[cc-channel-octo] Fatal error:', String(err));
  process.exit(1);
});

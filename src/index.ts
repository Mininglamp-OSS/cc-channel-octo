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
import { queryAgent } from './agent-bridge.js';
import { StreamRelay } from './stream-relay.js';
import { sendMessage, sendReadReceipt, getChannelMessages } from './octo/api.js';
import type { HistoricalMessage } from './octo/api.js';
import { ChannelType, MessageType } from './octo/types.js';
import type { BotMessage } from './octo/types.js';
import { resolveContent, tryResolveFile, resolveHistoricalMessagePlaceholder } from './inbound.js';
import { join } from 'node:path';

async function main(): Promise<void> {
  // --- Q8: Global unhandled rejection handler ---
  process.on('unhandledRejection', (reason) => {
    console.error('[cc-channel-octo] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });

  // --- Config ---
  const config = loadConfig();
  console.log(
    `[cc-channel-octo] Config loaded: apiUrl=${config.apiUrl}, cwd=${config.cwd}, ` +
    `dataDir=${config.dataDir}, sdk.model=${config.sdk.model ?? 'default'}, ` +
    `sdk.allowedTools=[${config.sdk.allowedTools.join(',')}], ` +
    `sdk.permissionMode=${config.sdk.permissionMode}, ` +
    `rateLimit=${config.rateLimit.maxPerMinute} req/min, ` +
    `context.maxContextChars=${config.context.maxContextChars}, ` +
    `context.historyLimit=${config.context.historyLimit}`,
  );

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
    const p = handleMessage(msg, config, store, router, groupContext, streamRelay)
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
): Promise<void> {
  const channelId = msg.channel_id ?? '';
  const channelType = msg.channel_type ?? ChannelType.DM;
  const isGroup = channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;

  // --- Route + pipeline under single session lock (no gap between route and processing) ---
  // For non-processed messages, routeAndHandle returns without calling handler.
  // We still need to cache group text messages for context.
  let wasProcessed = false;
  await router.routeAndHandle(msg, async (result) => {
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

      // G2: Inline text-file content for File payloads when feasible.
      if (
        msg.payload.type === MessageType.File &&
        resolved.mediaUrl
      ) {
        const filename = typeof msg.payload.name === 'string' ? msg.payload.name : '未知文件';
        const knownSize = typeof msg.payload.size === 'number' ? msg.payload.size : undefined;
        try {
          const fileResult = await tryResolveFile({
            url: resolved.mediaUrl,
            botToken: config.botToken,
            filename,
            knownSize,
          });
          if ('inlined' in fileResult) {
            bodyText = `[文件: ${filename}]\n\n--- 文件内容 ---\n${fileResult.inlined}\n--- 文件结束 ---`;
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
      const userContent = msg.payload.content ?? bodyText;

      // G3: Extract quoted/replied message content for LLM context.
      //
      // The quote payload comes from a previously-sent message (bounded by the
      // server's own size limits), but to honor cc-channel-octo's 32KB user
      // content gate without amplification we truncate the quoted body to a
      // small budget. The quoted content is supplementary context, not a
      // primary input, so a 4KB cap preserves usefulness without bypassing
      // the size guarantee documented in session-router.ts.
      let quotePrefix = '';
      const replyData = msg.payload?.reply;
      if (replyData) {
        const replyPayload = replyData?.payload;
        const rawReplyContent = replyPayload?.content ?? '';
        const replyFrom = replyData.from_name ?? replyData.from_uid ?? 'unknown';
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
          quotePrefix = `[Quoted message from ${replyFrom}]: ${truncated}\n---\n`;
        }
      }
      // Note: quotePrefix is added to LLM input only — store.appendUser below
      // persists the raw user content without the quote prefix to avoid prefix
      // duplication on conversation replay.
      const userContentForLLM = quotePrefix + bodyText;

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
            // and rebuild historyPrefix with the enriched data.
            seedHistoryFromApi(store, sessionKey, apiMessages, msg.from_uid);
            historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
          }
        } catch (err) {
          console.error(`[cc-channel-octo] G4 backfill failed for ${sessionKey}: ${String(err)}`);
        }
      }

      store.appendUser(sessionKey, userContent, msg.message_seq);

      // --- Query agent with structural role separation (Q3 fix) ---
      // userContentForLLM → user role (prompt), history + context → system role (systemPrompt)
      const rawChunks = queryAgent(userContentForLLM, historyPrefix, contextStr, config);

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
  if (!wasProcessed && isGroup && !msg.streamOn) {
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
 * Skips the current user's bot (replies come from the agent path) and
 * persists each historical message in chronological order.
 */
function seedHistoryFromApi(
  store: SessionStore,
  sessionKey: string,
  apiMessages: HistoricalMessage[],
  currentUserUid: string,
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
    // We don't know which side of the conversation each historical message
    // came from without the bot uid, so heuristic: from_uid matching the
    // current message's sender = user; everyone else = user too. The agent
    // sees the senders inside the rendered history via the [user]/[assistant]
    // labels we'll wire up later. For now, all historical messages are stored
    // as user role to preserve conversation flavor without falsely claiming
    // any of them came from us.
    void currentUserUid;
    store.appendUser(sessionKey, content, m.message_seq);
  }
}

main().catch((err) => {
  console.error('[cc-channel-octo] Fatal error:', String(err));
  process.exit(1);
});

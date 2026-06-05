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
import { sendMessage, sendReadReceipt } from './octo/api.js';
import { ChannelType, MessageType } from './octo/types.js';
import type { BotMessage } from './octo/types.js';
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
        // [Current message], not duplicated in [Group context].
        if (msg.payload.type === MessageType.Text && msg.payload.content) {
          groupContext.pushMessage(
            channelId,
            msg.from_uid,
            msg.from_name ?? msg.from_uid,
            msg.payload.content,
            msg.timestamp,
          );
        }
      }

      // --- Build history prefix BEFORE appending current message (G10: segmented) ---
      const userContent = msg.payload.content ?? '';

      // G3: Extract quoted/replied message content for LLM context
      let quotePrefix = '';
      const replyData = msg.payload?.reply;
      if (replyData) {
        const replyPayload = replyData.payload;
        const replyContent = replyPayload?.content ?? '';
        const replyFrom = replyData.from_name ?? replyData.from_uid ?? 'unknown';
        if (replyContent) {
          quotePrefix = `[Quoted message from ${replyFrom}]: ${replyContent}\n---\n`;
        }
      }
      const userContentForLLM = quotePrefix + (result.cleanContent ?? userContent);

      const historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
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

  // Cache non-processed group text messages for context.
  // G21: skip stream update messages — only cache the final (non-stream) message.
  if (!wasProcessed && isGroup && !msg.streamOn && msg.payload.type === MessageType.Text && msg.payload.content) {
    groupContext.pushMessage(
      channelId,
      msg.from_uid,
      msg.from_name ?? msg.from_uid,
      msg.payload.content,
      msg.timestamp,
    );
  }
}

main().catch((err) => {
  console.error('[cc-channel-octo] Fatal error:', String(err));
  process.exit(1);
});

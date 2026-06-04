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
import { buildPrompt, queryAgent } from './agent-bridge.js';
import { StreamRelay } from './stream-relay.js';
import { sendMessage } from './octo/api.js';
import { ChannelType, MessageType } from './octo/types.js';
import type { BotMessage } from './octo/types.js';
import { join } from 'node:path';

async function main(): Promise<void> {
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

  // --- Stream relay ---
  const streamRelay = new StreamRelay();

  // --- Gateway ---
  const gateway = new OctoGateway(config);
  await gateway.start();

  console.log(`[cc-channel-octo] Bot started: id=${gateway.botId}`);

  // --- Session router ---
  const router = new SessionRouter(config, gateway.botId);

  // --- Message handler ---
  gateway.setMessageHandler((msg: BotMessage) => {
    void handleMessage(msg, config, store, router, groupContext, streamRelay);
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

  // --- Route: filter, mention gate, rate limit ---
  const result = await router.route(msg);
  if (!result || !result.shouldProcess) {
    // Not processed — still cache group text messages for context
    if (isGroup && msg.payload.type === MessageType.Text && msg.payload.content) {
      groupContext.pushMessage(
        channelId,
        msg.from_uid,
        msg.from_name ?? msg.from_uid,
        msg.payload.content,
        msg.timestamp,
      );
    }
    return;
  }

  const { sessionKey } = result;

  // --- Entire agent pipeline under session lock to prevent history interleaving ---
  await router.withSessionLock(sessionKey, async () => {
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

      // --- Build history prefix BEFORE appending current message ---
      const userContent = msg.payload.content ?? '';
      const historyPrefix = store.buildHistoryPrefix(sessionKey, config.context.historyLimit);
      store.appendUser(sessionKey, userContent);

      // --- Build prompt + query agent ---
      const prompt = buildPrompt(historyPrefix, contextStr, userContent);
      const rawChunks = queryAgent(prompt, config);

      // Tee the generator: collect full text while streaming to Octo
      const collected: string[] = [];
      async function* teeChunks(): AsyncIterable<string> {
        for await (const chunk of rawChunks) {
          collected.push(chunk);
          yield chunk;
        }
      }

      // --- Stream output to Octo ---
      await streamRelay.deliver(channelId, channelType, teeChunks(), config.apiUrl, config.botToken);

      // --- Store assistant response in history ---
      const fullResponse = collected.join('');
      if (fullResponse) {
        store.appendAssistant(sessionKey, fullResponse);
      }

      // --- Resolve mentions in group reply (wired to sendMessage) ---
      // NOTE: Mention resolution is deferred to v0.2 when StreamRelay gains
      // mention-aware delivery. For now the response is already sent via stream.
      // resolveMentions would need to be called before delivery, which requires
      // buffering the full response first (conflicts with streaming). TODO v0.2.

    } catch (err) {
      console.error(`[cc-channel-octo] Error processing message (session=${sessionKey}):`, err);
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
}

main().catch((err) => {
  console.error('[cc-channel-octo] Fatal error:', err);
  process.exit(1);
});

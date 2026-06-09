/**
 * cc-channel-octo — Entry point.
 * Bridge Claude Code (via Claude Agent SDK) to Octo IM.
 *
 * Orchestrates: loadConfig → createAdapter → SessionStore.init →
 * OctoGateway.start → setMessageHandler wiring the full pipeline.
 */

import { loadConfig, resolveBotConfigs } from './config.js';
import { createAdapter } from './db-adapter.js';
import { SessionStore } from './session-store.js';
import { OctoGateway } from './gateway.js';
import { SessionRouter } from './session-router.js';
import { GroupContext } from './group-context.js';
import { queryAgent } from './agent-bridge.js';
import { sanitizeDisplayName, escapeSectionMarkers, sanitizePromptBody } from './prompt-safety.js';
import type { SessionCtx } from './cwd-resolver.js';
import { cleanupExpiredCwds, resolveMemoryDir, resolveSessionCwd } from './cwd-resolver.js';
import { StreamRelay } from './stream-relay.js';
import { sendMessage, sendReadReceipt, getChannelMessages, getUploadCredentials } from './octo/api.js';
import type { HistoricalMessage } from './octo/api.js';
import { ChannelType, MessageType } from './octo/types.js';
import type { BotMessage } from './octo/types.js';
import { resolveContent, tryResolveFile, resolveHistoricalMessagePlaceholder } from './inbound.js';
import { downloadInboundImage, MAX_IMAGES_PER_MESSAGE } from './media-inbound.js';
import { handleCommand } from './commands.js';
import { loadGroupConfig } from './group-config.js';
import { CronStore } from './cron-store.js';
import { CronScheduler } from './cron-scheduler.js';
import { createCronToolServer, CRON_TOOL_SERVER_NAME, type CronSessionCoords } from './cron-tool.js';
import { buildInlinedFileBody, truncateUtf8ByBytes } from './file-inline-wrap.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function main(): Promise<void> {
  // --- Q8: Global unhandled rejection handler ---
  process.on('unhandledRejection', (reason) => {
    console.error('[cc-channel-octo] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
  });

  // --- Config ---
  const config = loadConfig();
  // v0.3 multi-bot: expand into one concrete Config per bot. Single-bot configs
  // resolve to a 1-element array, so the loop below is the same code path.
  const botConfigs = resolveBotConfigs(config);
  const multi = botConfigs.length > 1;
  if (multi) {
    console.log(`[cc-channel-octo] Multi-bot mode: starting ${botConfigs.length} bots`);
  }

  // Each bot runs a fully independent stack (gateway + router + store + cwd
  // cleanup), isolated by its own dataDir/cwdBase. They share nothing stateful,
  // so per-user history and sandboxes never cross between bots.
  //
  // Two-phase startup so no WebSocket ACKs a message before its handler is
  // ready: startBot() registers over REST (gets botId) and installs the message
  // handler, but does NOT open the socket. We then cross-register sibling bot
  // ids, and only AFTER that connect every socket.
  // Start each bot's pipeline. startBot() acquires the gateway.lock, opens the
  // SQLite store, and arms the cwd-cleanup interval BEFORE any socket connects —
  // so if one bot's startBot() rejects (bad token, taken lock), the bots that
  // already succeeded must be torn down, or their locks/stores/intervals leak.
  // Promise.all would discard the resolved stacks on first rejection, so settle
  // all and clean up the successful ones before rethrowing.
  const startResults = await Promise.allSettled(botConfigs.map((c) => startBot(c, multi)));
  const stacks: BotStack[] = [];
  let startError: unknown;
  for (const r of startResults) {
    if (r.status === 'fulfilled') stacks.push(r.value);
    else startError = startError ?? r.reason;
  }
  if (startError) {
    console.error('[cc-channel-octo] Startup failed; cleaning up bots that did start...');
    await Promise.allSettled(stacks.map((s) => s.shutdown()));
    throw startError;
  }

  // Multi-bot loop guard: make every router aware of ALL bot ids in this
  // process, so a mention-free group can't let one bot reply to another's
  // messages (knownBotUids → looksLikeBot → dropped). botIds are known after
  // register() (REST), before any socket is open.
  if (multi) {
    const allBotIds = stacks.map((s) => s.botId);
    for (const s of stacks) {
      for (const id of allBotIds) {
        if (id !== s.botId) s.router.registerKnownBot(id);
      }
    }
  }

  // Handlers are wired and siblings registered — now open every socket. From
  // this point inbound messages are dispatched, never ACK'd-and-dropped. Awaited
  // so a connection failure surfaces as a startup error. On a partial failure
  // (e.g. one bot's lock is held), shut down the stacks that did start so we
  // don't leave open sockets / stores dangling before the fatal exit.
  const connected: BotStack[] = [];
  try {
    for (const s of stacks) {
      await s.connect();
      connected.push(s);
    }
  } catch (err) {
    console.error('[cc-channel-octo] Startup failed during socket connect; cleaning up...');
    await Promise.allSettled(connected.map((s) => s.shutdown()));
    throw err;
  }

  // Wire a single process-wide shutdown that drains every bot, so N gateways
  // don't each call process.exit. The per-gateway signal handlers are disabled
  // in multi-bot mode (handleSignals=false); we own the signals here.
  if (multi) {
    const shutdownAll = async (signal: string): Promise<void> => {
      console.log(`[cc-channel-octo] Received ${signal}, shutting down ${stacks.length} bots...`);
      await Promise.allSettled(stacks.map((s) => s.shutdown()));
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdownAll('SIGINT'));
    process.once('SIGTERM', () => void shutdownAll('SIGTERM'));
  }

  console.log('[cc-channel-octo] Ready — listening for messages');
}

interface BotStack {
  botId: string;
  router: SessionRouter;
  connect: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Start one bot's full pipeline. `ownSignals` is true for the single-bot case
 * (the gateway registers its own SIGINT/SIGTERM handlers); false in multi-bot
 * mode where main() owns a single combined shutdown.
 */
async function startBot(config: ReturnType<typeof loadConfig>, multi: boolean): Promise<BotStack> {
  const label = multi ? `[${config.botId}] ` : '';
  const cwdBase = config.cwdBase ?? config.cwd;
  console.log(
    `[cc-channel-octo] ${label}Config loaded: apiUrl=${config.apiUrl}, cwdBase=${cwdBase}, ` +
    `dataDir=${config.dataDir}, sdk.model=${config.sdk.model ?? 'default'}, ` +
    `sdk.allowedTools=${config.sdk.allowedTools === '*' ? '*' : `[${config.sdk.allowedTools.join(',')}]`}, ` +
    `sdk.permissionMode=${config.sdk.permissionMode}, ` +
    `rateLimit=${config.rateLimit.maxPerMinute} req/min`,
  );

  // --- Q3: per-session cwd cleanup (7d TTL) ---
  cleanupExpiredCwds(cwdBase);
  const CWD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const cwdCleanupTimer = setInterval(() => {
    cleanupExpiredCwds(cwdBase);
  }, CWD_CLEANUP_INTERVAL_MS);
  cwdCleanupTimer.unref();

  // --- Database (per-bot dataDir → no cross-bot history) ---
  const dbPath = join(config.dataDir, 'cc-octo.db');
  const adapter = createAdapter(dbPath);
  const store = new SessionStore(adapter);
  store.init();
  const cleaned = store.cleanExpired();
  if (cleaned > 0) {
    console.log(`[cc-channel-octo] ${label}Cleaned ${cleaned} expired session(s)`);
  }

  // --- Auto-memory base (create eagerly so a deleted/unmounted memory volume
  // fails loudly at boot instead of silently disabling recall at message time). ---
  const memoryBase = config.memoryBase ?? join(config.dataDir, 'memory');
  mkdirSync(memoryBase, { recursive: true });

  // --- Group context ---
  const groupContext = new GroupContext(adapter, config.context.maxContextChars);
  groupContext.loadAllFromDb();

  // --- #115: cron (opt-in). Store is shared by the per-turn cron tool (writes)
  // and the scheduler (reads + fires). Scheduler is armed after the handler is
  // installed (see below), stopped in shutdown. ---
  let cronStore: CronStore | undefined;
  let cronScheduler: CronScheduler | undefined;
  if (config.sdk.cron && config.botId) {
    cronStore = new CronStore(join(config.baseDir, config.botId, 'cron.json'));
  }

  // --- Stream relay ---
  const streamRelay = new StreamRelay();

  // --- Gateway. In multi-bot mode main() owns shutdown signals, so the gateway
  // must NOT register its own (N gateways racing process.exit). ---
  const gateway = new OctoGateway(config, { handleSignals: !multi });
  // Phase 1: register over REST (gets botId) — does NOT open the socket yet, so
  // no message can arrive before the handler below is installed.
  await gateway.register();
  console.log(`[cc-channel-octo] ${label}Bot registered: id=${gateway.botId}`);

  // #115: cron creation/deletion is owner-gated on gateway.ownerUid. If the
  // registration didn't return an owner_uid, the gate can never pass and the
  // cron tool is silently unusable — warn loudly so the operator isn't left
  // wondering why every cron_create is rejected.
  if (config.sdk.cron && !gateway.ownerUid) {
    console.warn(
      `[cc-channel-octo] ${label}sdk.cron is enabled but the bot has no owner_uid ` +
      `(registration returned none) — cron_create/delete will be rejected for everyone. ` +
      `The cron tool is effectively disabled until the bot has an owner.`,
    );
  }

  // #86: prefetch the media CDN host (best-effort). Octo serves media from a
  // separate CDN than apiUrl; without this, inbound image URLs on the CDN host
  // are rejected by buildMediaUrl and the agent can't see them. The STS
  // upload-credentials response carries cdnBaseUrl; we only need its host. A
  // failure leaves mediaCdnHost undefined (same-host-only media), never fatal.
  try {
    const creds = await getUploadCredentials({
      apiUrl: config.apiUrl,
      botToken: config.botToken,
      // The credentials endpoint validates the filename's type; use an image
      // name so the probe isn't rejected (file_type_unsupported). We only read
      // cdnBaseUrl from the response — nothing is uploaded.
      filename: 'probe.png',
    });
    if (creds.cdnBaseUrl) {
      config.mediaCdnHost = new URL(creds.cdnBaseUrl).host;
      console.log(`[cc-channel-octo] ${label}Media CDN host: ${config.mediaCdnHost}`);
    }
  } catch (err) {
    console.warn(`[cc-channel-octo] ${label}Could not prefetch media CDN host (inbound media limited to apiUrl host): ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- Session router ---
  const router = new SessionRouter(config, gateway.botId, gateway.ownerUid);

  // --- Active handler tracking (Q6: in-flight drain on shutdown) ---
  const activeHandlers = new Set<Promise<void>>();

  // Install the message handler NOW (before the socket opens). The socket is
  // opened later via connect(), after main() has cross-registered sibling bot
  // ids — so there is no window where a message is ACK'd and dropped, nor one
  // where a sibling bot's message slips through unrecognized.
  const onInbound = (msg: BotMessage): void => {
    if (gateway.draining) return;
    // Drop self-authored messages. OctoGateway.handleMessage() already filters
    // these on the WS path; guard here too for safety (otherwise a bot's own
    // group message could be cached into group context as un-processed chatter).
    if (msg.from_uid === gateway.botId) return;
    const p = handleMessage(msg, config, store, router, groupContext, streamRelay, gateway.botId, cronStore)
      .catch((err) => {
        console.error(`[cc-channel-octo] ${label}Unhandled message handler error:`, err instanceof Error ? err.message : err);
      })
      .finally(() => {
        activeHandlers.delete(p);
      });
    activeHandlers.add(p);
  };
  gateway.setMessageHandler(onInbound);

  // #115: arm the cron scheduler now that onInbound exists. Fired tasks go
  // through the exact same pipeline as real inbound messages. The fire callback
  // returns a tracked promise that REJECTS on handler error (distinct from
  // onInbound, which swallows) so the scheduler can attribute a delivery failure
  // to the specific task. Still tracked in activeHandlers for shutdown drain.
  if (cronStore) {
    cronScheduler = new CronScheduler({
      cronStore,
      onFire: (msg: BotMessage): Promise<void> => {
        if (gateway.draining) return Promise.resolve();
        const p = handleMessage(msg, config, store, router, groupContext, streamRelay, gateway.botId, cronStore)
          .finally(() => { activeHandlers.delete(p); });
        activeHandlers.add(p);
        return p;
      },
      label,
    });
    cronScheduler.start();
  }

  // Phase 2 (called by main() after cross-registration): open the WebSocket.
  // Async + awaited so a connection failure fails startup instead of leaving
  // the process "ready" with no inbound endpoint.
  const connect = async (): Promise<void> => {
    gateway.connect();
    console.log(`[cc-channel-octo] ${label}Bot connected: id=${gateway.botId}`);
  };

  const shutdown = async (): Promise<void> => {
    clearInterval(cwdCleanupTimer);
    cronScheduler?.stop();
    await gateway.stop(activeHandlers);
    store.close();
  };
  // Single-bot: the gateway's own SIGINT/SIGTERM handler invokes this.
  gateway.setShutdownCallback(shutdown);

  return { botId: gateway.botId, router, connect, shutdown };
}


/**
 * Process a single inbound message through the full pipeline: route → context →
 * agent query → stream → persist. Exported so tests can drive the real pipeline
 * (not a replica) — `main()` is the only production caller.
 */
export async function handleMessage(
  msg: BotMessage,
  config: ReturnType<typeof loadConfig>,
  store: SessionStore,
  router: SessionRouter,
  groupContext: GroupContext,
  streamRelay: StreamRelay,
  botId: string,
  cronStore?: CronStore,
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

      // Session routing context (cwd/memory partition). Built here (before media
      // resolution) so inbound images can be downloaded INTO this session's cwd
      // sandbox for the agent to Read. Group keys are channel_id alone (shared
      // workspace); DM keys are per-peer. See cwd-resolver.ts header.
      const sessionCtx: SessionCtx = {
        kind: isGroup ? 'group' : 'dm',
        sessionKey,
      };

      // --- v0.3: in-chat slash commands (/reset, /config, /help) ---
      // Handled before group-context caching, history append, and the agent
      // query — so a command never reaches the LLM, is not stored as a turn,
      // and does not leak into other members' group context. Only text
      // messages carry cleanContent; non-text payloads skip this entirely.
      // Scoped to this sessionKey: in a DM that's the peer; in a GROUP the
      // sessionKey is the channel, so /reset clears the WHOLE group's shared
      // history (any member can — by the shared-workspace design) and does NOT
      // clear long-term memory. See commands.ts.
      if (result.cleanContent !== undefined) {
        const command = handleCommand(result.cleanContent, sessionKey, store, config, msg.message_seq);
        if (command.handled) {
          if (command.reply) {
            await sendMessage({
              apiUrl: config.apiUrl,
              botToken: config.botToken,
              channelId,
              channelType,
              content: command.reply,
            });
          }
          // G8: send a read receipt for command messages too, mirroring the
          // normal message path (otherwise handled commands would be the only
          // processed messages that never get marked read).
          if (msg.message_id && msg.channel_id && msg.channel_type !== undefined) {
            sendReadReceipt({
              apiUrl: config.apiUrl,
              botToken: config.botToken,
              channelId: msg.channel_id,
              channelType: msg.channel_type,
              messageIds: [msg.message_id],
            }).catch((err) => console.error(`[cc-channel-octo] readReceipt failed: ${String(err)}`));
          }
          return; // skip context, history, and the agent query entirely
        }
      }

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
      const resolved = resolveContent(msg.payload, config.apiUrl, config.mediaCdnHost);
      let bodyText = result.cleanContent ?? resolved.text;

      // Compact history record. For File payloads we store only the metadata
      // line (not the inlined contents) so a user dropping a few text files
      // can't blow up the system prompt on subsequent turns. See PR#33
      // follow-up issue ·2 (齐哥 review).
      let historyRecord = bodyText;

      // #86: Native image input. Octo delivers images as URLs; download them
      // INTO this session's cwd sandbox so the agent can SEE them via the Read
      // tool (the SDK's Read renders image files), instead of only getting a URL
      // string. Covers single-image (Image/GIF) and RichText embedded images.
      // History keeps the compact marker (not the local path) so it doesn't
      // accumulate stale paths. Falls back to the URL marker on any failure.
      {
        const imageUrls: string[] = [];
        if (
          (msg.payload.type === MessageType.Image || msg.payload.type === MessageType.GIF) &&
          resolved.mediaUrl
        ) {
          imageUrls.push(resolved.mediaUrl);
        } else if (msg.payload.type === MessageType.RichText && resolved.mediaUrls?.length) {
          imageUrls.push(...resolved.mediaUrls);
        }
        if (imageUrls.length > 0) {
          const cwdBase = config.cwdBase ?? config.cwd;
          const cwdDir = resolveSessionCwd(cwdBase, sessionCtx);
          const localPaths: string[] = [];
          for (const url of imageUrls.slice(0, MAX_IMAGES_PER_MESSAGE)) {
            try {
              const r = await downloadInboundImage({ url, cwdDir, botToken: config.botToken, apiUrl: config.apiUrl });
              if ('relPath' in r) {
                localPaths.push(r.relPath);
              } else {
                console.warn(`[cc-channel-octo] inbound image skipped: ${r.error}`);
              }
            } catch (err) {
              console.error(`[cc-channel-octo] inbound image download failed: ${String(err)}`);
            }
          }
          if (localPaths.length > 0) {
            // Append a Read hint for THIS turn only (bodyText), keeping the URL
            // marker too as a fallback reference. historyRecord stays unchanged.
            const hint = localPaths.length === 1
              ? `\n[已下载图片到本地: ${localPaths[0]} — 请用 Read 工具查看]`
              : `\n[已下载 ${localPaths.length} 张图片到本地: ${localPaths.join(', ')} — 请用 Read 工具逐个查看]`;
            bodyText = bodyText + hint;
          }
        }
      }

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
          // Reuse the shared byte-safe truncator (no second copy of the loop).
          const { truncated: body, wasTruncated } = truncateUtf8ByBytes(rawReplyContent, QUOTE_MAX_BYTES);
          const quoteBody = wasTruncated ? `${body}…[truncated]` : body;
          // Shared choke point: bound+strip the user display name so it can't
          // break out of the `[Quoted message from <name>]` marker, and escape
          // role labels + section markers in the body (sanitizePromptBody).
          const replyFrom = sanitizeDisplayName(rawReplyFrom, 'unknown');
          quotePrefix = escapeSectionMarkers(
            `[Quoted message from ${replyFrom}]: ${sanitizePromptBody(quoteBody)}\n---\n`,
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
      // Multi-bot: the sentinel set is process-global but each bot has its own
      // store, so key it by botId+sessionKey — otherwise bot A marking a session
      // backfilled would make bot B skip backfill against its own empty DB.
      const backfillKey = `${botId}\u0000${sessionKey}`;
      let historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
      if (
        isGroup &&
        !historyPrefix &&
        !backfilledSessions.has(backfillKey) &&
        msg.channel_id &&
        msg.channel_type !== undefined
      ) {
        backfilledSessions.add(backfillKey);
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
            //
            // v0.3 /reset barrier: skip any historical message at or before the
            // reset point so a cleared conversation is not resurrected here.
            const resetBarrier = store.getResetBarrier(sessionKey);
            seedHistoryFromApi(store, sessionKey, apiMessages, botId, resetBarrier);
            historyPrefix = store.buildSegmentedHistoryPrefix(sessionKey, config.context.historyLimit);
          }
        } catch (err) {
          console.error(`[cc-channel-octo] G4 backfill failed for ${sessionKey}: ${String(err)}`);
        }
      }

      store.appendUser(sessionKey, userContent, msg.message_seq, msg.from_name ?? msg.from_uid);

      // --- Query agent with structural role separation (Q3 fix) ---
      // userContentForLLM → user role (prompt), history + context → system role (systemPrompt)
      // sessionCtx (cwd/memory partition) was built earlier so inbound images
      // could be downloaded into this session's sandbox.

      // v0.3 tool progress (opt-in): send a brief "🔧 Running <tool>(<params>)"
      // notice as the agent invokes tools. Dedup consecutive identical notices
      // and cap the count per turn so a tool-heavy run doesn't spam the channel.
      let onToolUse: ((toolName: string, toolInput?: unknown) => void) | undefined;
      if (config.sdk.toolProgress) {
        let lastNotice = '';
        let noticeCount = 0;
        const MAX_TOOL_NOTICES = 10;
        onToolUse = (toolName: string, toolInput?: unknown): void => {
          const params = formatToolParams(toolInput);
          const label = params ? `${toolName}(${params})` : toolName;
          if (label === lastNotice) return; // collapse exact repeats
          lastNotice = label;
          if (noticeCount >= MAX_TOOL_NOTICES) return;
          noticeCount++;
          // Fire-and-forget — never block or fail the agent stream on a notice.
          sendMessage({
            apiUrl: config.apiUrl,
            botToken: config.botToken,
            channelId,
            channelType,
            content: `🔧 Running ${label}…`,
          }).catch((err) =>
            console.error(`[cc-channel-octo] tool-progress send failed: ${String(err)}`),
          );
        };
      }

      // v0.3 persistent sessions (opt-in): resume the SDK session for this
      // sessionKey so workspace state (open files, command history, context)
      // survives across messages. On resume the SDK session already holds the
      // conversation, so we pass an EMPTY historyPrefix to queryAgent to avoid
      // double-injecting history. We still persist to our own store (for the
      // non-persistent fallback, /reset, and group context), so this only
      // changes what the agent is *prompted* with, not what we record.
      let sessionOpts: { resume?: string; onSessionId?: (id: string) => void; groupInstructions?: string; memoryDir?: string; mcpServers?: Record<string, ReturnType<typeof createCronToolServer>> } | undefined;
      let historyForQuery = historyPrefix;
      if (config.sdk.persistentSession) {
        const resume = store.getSdkSessionId(sessionKey);
        if (resume) historyForQuery = '';
        sessionOpts = {
          resume,
          onSessionId: (id: string) => store.setSdkSessionId(sessionKey, id),
        };
      }

      // v1.1: point the SDK auto-memory at a stable per-session dir under
      // memoryBase (<baseDir>/<botId>/memory, outside cwdBase so it's never
      // reclaimed by the cwd TTL). Same partitioning as the session: group=shared
      // per channel, DM=per peer. memoryBase is always populated by
      // resolveBotConfigs(); fall back defensively for hand-built configs/tests.
      {
        const memBase = config.memoryBase ?? join(config.dataDir, 'memory');
        const memoryDir = resolveMemoryDir(memBase, sessionCtx);
        sessionOpts = { ...(sessionOpts ?? {}), memoryDir };
      }

      // v1.0 GROUP.md: inject operator-provided per-group instructions (from
      // config.groupConfigDir/<channelId>.md) into the system prompt. Only for
      // groups — DMs key on the peer uid, not a shared channel.
      if (isGroup) {
        const groupInstructions = loadGroupConfig(config.groupConfigDir, channelId);
        if (groupInstructions) {
          sessionOpts = { ...(sessionOpts ?? {}), groupInstructions };
        }
      }

      // #115: when cron is on, inject the cron MCP tool bound to THIS session's
      // raw coords (so a task created now fires + replies here) and gated to the
      // bot owner uid. Per-turn server (coords differ per message).
      if (config.sdk.cron && cronStore && config.botId) {
        const coords: CronSessionCoords = {
          channelId,
          channelType,
          fromUid: msg.from_uid,
          fromName: msg.from_name,
        };
        const cronServer = createCronToolServer(cronStore, coords, router.getOwnerUid());
        sessionOpts = {
          ...(sessionOpts ?? {}),
          mcpServers: { [CRON_TOOL_SERVER_NAME]: cronServer },
        };
      }

      const rawChunks = queryAgent(userContentForLLM, historyForQuery, contextStr, config, sessionCtx, onToolUse, sessionOpts);

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
        store.appendAssistant(sessionKey, fullResponse, msg.message_seq, botId);
        // G10: mark this message_seq as the last one we replied to. Next turn's
        // segmented history will treat messages with seq <= this as [answered].
        // #115: a synthetic cron fire carries message_seq=0 (no real wire seq);
        // setting the cursor to 0 would reset it and mis-segment real history as
        // all-[new]. Only advance the cursor for a real positive seq.
        if (typeof msg.message_seq === 'number' && msg.message_seq > 0) {
          store.setLastBotReplySeq(sessionKey, msg.message_seq);
        }
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

/** Max length of the rendered tool-params string in a 🔧 progress notice. */
export const MAX_TOOL_PARAM_CHARS = 120;

/**
 * Render a tool's `input` as a compact, truncated one-liner for a tool-progress
 * notice — e.g. `{command:"octo-cli group list"}` → `command: octo-cli group…`.
 *
 * Best-effort + defensive: this string is sent to a chat channel, so it is
 * length-capped (MAX_TOOL_PARAM_CHARS) to avoid flooding and to bound accidental
 * exposure of long inputs. Returns '' when there's nothing useful to show (the
 * caller then renders just the bare tool name). Newlines collapse to one line.
 */
export function formatToolParams(input: unknown): string {
  if (input === undefined || input === null) return '';
  let s: string;
  if (typeof input === 'string') {
    s = input;
  } else if (typeof input === 'object') {
    // Prefer a flat "k: v, k: v" of primitive fields; fall back to JSON only
    // when there ARE keys but none are primitive (e.g. all-nested). An object
    // with no own keys renders as nothing (bare tool name).
    const obj = input as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v === 'object') continue; // skip nested/empty
      parts.push(`${k}: ${String(v)}`);
    }
    if (parts.length > 0) s = parts.join(', ');
    else if (Object.keys(obj).length === 0) s = '';
    else s = safeJson(obj);
  } else {
    s = String(input);
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length === 0) return '';
  return s.length > MAX_TOOL_PARAM_CHARS ? `${s.slice(0, MAX_TOOL_PARAM_CHARS - 1)}…` : s;
}

/** JSON.stringify that never throws (circular refs → ''). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
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
  resetBarrier?: number,
): void {
  // Older messages first — sync API returns newest-first depending on pull_mode.
  const ordered = apiMessages
    .slice()
    .sort((a, b) => (a.message_seq ?? 0) - (b.message_seq ?? 0));
  for (const m of ordered) {
    // v0.3 /reset barrier: never resurrect messages at or before the reset
    // point. Messages with no seq are treated as un-orderable and skipped when a
    // barrier exists (we cannot prove they post-date the reset).
    if (resetBarrier !== undefined && (m.message_seq ?? 0) <= resetBarrier) {
      continue;
    }
    const placeholder = resolveHistoricalMessagePlaceholder(m.type, m.name);
    const content = m.content && m.content.trim() !== ''
      ? m.content
      : placeholder;
    if (!content) continue;
    if (botId && m.from_uid === botId) {
      store.appendAssistant(sessionKey, content, m.message_seq, botId);
    } else {
      store.appendUser(sessionKey, content, m.message_seq, m.from_name ?? m.from_uid);
    }
  }
}

// Only auto-start the gateway when this module is run directly (production
// entrypoint), NOT when it is imported (e.g. tests importing handleMessage).
// `process.argv[1]` is undefined under `node -e`/`--input-type`, so guard it.
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((err) => {
    console.error('[cc-channel-octo] Fatal error:', String(err));
    process.exit(1);
  });
}

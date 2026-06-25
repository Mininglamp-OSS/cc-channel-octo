/**
 * Session Router — routing + concurrency control + mention gate + rate limiting.
 */

import type { Config } from './config.js';
import type { BotMessage, MentionEntity } from './octo/types.js';
import { ChannelType, MessageType } from './octo/types.js';
import { sendMessage } from './octo/api.js';
import { isAuthenticCronFire } from './cron-fire-marker.js';

export interface RouteResult {
  sessionKey: string;
  shouldProcess: boolean;
  message: BotMessage;
  /** User content with leading @botname stripped (for LLM input). */
  cleanContent?: string;
  /**
   * Reason for rejection when shouldProcess is false.
   *
   * Only emitted for cases where the caller should treat the message as
   * 'do-not-cache-in-group-context' (rate-limited or oversized — these are
   * actively-rejected messages from a flooder). Silent-drop cases (blocked
   * bot, self message, system event, not mentioned) leave rejectionReason
   * undefined: those messages are legitimate group chatter the agent
   * should still see in [Group context].
   *
   * C1 / P2.5 (Stage 6): added to fix the channel where rate-limited or
   * oversized messages still polluted the group context cache. C1 follow-up
   * cleanup (齐静春 PR#41 review): trimmed to the 2 reasons actually emitted
   * so the type doesn't suggest a wider contract than the code provides.
   * Add more reasons here when corresponding emit sites land.
   */
  rejectionReason?: 'rate_limited' | 'oversized';
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  /** Whether the user has already been notified of rate limiting in this window. */
  notified: boolean;
}

const BUCKET_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Global rate limit: 10x per-session limit, shared across all sessions. */
const GLOBAL_RATE_MULTIPLIER = 10;

/** Maximum allowed content length in bytes (Q10). Messages exceeding this are rejected. */
const MAX_CONTENT_BYTES = 32_768; // 32 KB

export class SessionRouter {
  private readonly config: Config;
  private readonly robotId: string;
  /** G18: owner_uid from registerBot. Stored for future permission model. */
  private readonly ownerUid: string;
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();
  /** G20: per-user buckets keyed by from_uid alone (cross-channel rate limit). */
  private readonly userBuckets = new Map<string, TokenBucket>();
  private globalBucket: TokenBucket | null = null;
  /**
   * G14: UIDs known to be bots. Initialized with this bot's robotId; can be
   * extended via registerKnownBot() for future multi-bot deployments.
   */
  private readonly knownBotUids = new Set<string>();

  constructor(config: Config, robotId: string, ownerUid = '') {
    this.config = config;
    this.robotId = robotId;
    this.ownerUid = ownerUid;
    this.knownBotUids.add(robotId);
  }

  /** G14: register another known bot uid (future multi-bot support). */
  registerKnownBot(uid: string): void {
    if (uid) this.knownBotUids.add(uid);
  }

  /**
   * Unregister a sibling bot uid (hot-reload: a bot was removed at runtime).
   * Never drops this router's OWN robotId — self is always a bot, removing it
   * would let the loop guard treat this bot's own echoes as user input.
   */
  unregisterKnownBot(uid: string): void {
    if (uid && uid !== this.robotId) this.knownBotUids.delete(uid);
  }

  /** Test/diagnostics: snapshot of currently-known bot uids. */
  knownBotUidsSnapshot(): ReadonlySet<string> {
    return new Set(this.knownBotUids);
  }

  /** G18: owner_uid stored from registerBot. Used by future permission model. */
  getOwnerUid(): string {
    return this.ownerUid;
  }

  /**
   * Acquire a per-session lock for the full message handling pipeline.
   * Callers (e.g. index.ts) use this to ensure the entire handleMessage
   * chain — not just routing — runs serially per session key.
   */
  async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inboundQueues.get(key) ?? Promise.resolve();
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    this.inboundQueues.set(key, gate);

    try {
      await prev;
      return await fn();
    } finally {
      resolveGate();
      if (this.inboundQueues.get(key) === gate) {
        this.inboundQueues.delete(key);
      }
    }
  }

  /**
   * Route a message and, if it should be processed, run the handler callback
   * under the same per-session lock. This ensures no gap between route decision
   * and pipeline execution — concurrent same-session messages cannot interleave.
   */
  /**
   * Route a message and, if it should be processed, run the handler callback
   * under the same per-session lock. This ensures no gap between route decision
   * and pipeline execution — concurrent same-session messages cannot interleave.
   *
   * Returns the RouteResult (or `null` for silent-drop cases) so the caller
   * can inspect `rejectionReason` to decide whether the message should still
   * influence downstream side-effects like group context caching
   * (C1 / P2.5 — stage 6).
   */
  async routeAndHandle(
    msg: BotMessage,
    handler: (result: RouteResult) => Promise<void>,
  ): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, async () => {
      const result = await this.processMessage(msg, key);
      if (result && result.shouldProcess) {
        await this.runHandlerWithTimeout(result, handler);
      }
      return result;
    });
  }

  /**
   * #141: Run the handler under a dispatch timeout so a hung turn (a stuck SDK
   * query, a wedged tool subprocess, a stalled stream) cannot block the session
   * forever. The handler runs inside withSessionLock — if it never returns, the
   * lock's gate never resolves and EVERY subsequent message for this session is
   * stuck permanently (silent). Racing the handler against a timeout guarantees
   * the lock releases.
   *
   * Scope (mirrors openclaw #75): we do NOT cancel the in-flight turn — the SDK
   * query keeps running to completion in the background; we only unblock the
   * queue. Worst case is a delayed real reply arriving after the apology.
   *
   * `timeoutError` is a per-invocation Error so the catch identifies OUR timeout
   * by reference equality, never by string comparison (a same-text upstream
   * error must not be misclassified).
   */
  private async runHandlerWithTimeout(
    result: RouteResult,
    handler: (result: RouteResult) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = this.config.dispatchTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) {
      // Timeout disabled — run unguarded.
      await handler(result);
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`dispatch timed out after ${timeoutMs}ms`);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
    });

    // The handler keeps running after a timeout (we don't cancel the in-flight
    // turn — see scope note above). Once the race settles on timeoutError, that
    // orphaned promise is no longer awaited; attach a no-op catch so a late
    // rejection from a handler that doesn't self-contain its errors can't surface
    // as an unhandledRejection. Today's caller (index.ts) is fully try/caught, so
    // this is defense-in-depth for future callers.
    const handlerPromise = handler(result);
    handlerPromise.catch(() => { /* swallow late rejection after timeout */ });

    try {
      await Promise.race([handlerPromise, timeoutPromise]);
    } catch (err) {
      if (err === timeoutError) {
        console.warn(
          `session-router: dispatch hung past ${timeoutMs}ms, releasing session lock (session=${result.sessionKey})`,
        );
        // Bounded apology — replySafe swallows its own errors, and the
        // underlying sendMessage in octo/api.ts is itself time-bounded, so a
        // sick Octo API can't re-hang us here.
        await this.replySafe(result.message, '⚠️ 处理超时，请稍后重试。');
        return; // swallow: the lock releases, the queue advances
      }
      // A real handler error — index.ts's handler already catches and replies
      // internally, so reaching here is unexpected. Swallow to keep the lock
      // release path identical (never let an error wedge the queue).
      console.error(
        `session-router: handler error (session=${result.sessionKey}): ${String(err)}`,
      );
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async route(msg: BotMessage): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, () => this.processMessage(msg, key));
  }

  sessionKey(msg: BotMessage): string {
    const spaceId = this.extractSpaceId(msg);
    if (msg.channel_type === ChannelType.DM) {
      // DM is per-user (private): same peer always resumes the same session.
      // from_uid IS the peer's identity here; a missing one is unroutable —
      // never fall back to '' (that would collapse every uid-less DM into ONE
      // shared session across unrelated peers, leaking history/memory). Mirrors
      // the group channel_id guard below. Caught upstream → message dropped.
      if (!msg.from_uid) {
        throw new Error('DM message has no from_uid — cannot derive a session key');
      }
      return spaceId ? `${spaceId}:${msg.from_uid}` : msg.from_uid;
    }
    // Group is per-CHANNEL (shared): every member of a group shares one session,
    // history, working dir, and memory — a group is a collective workspace, not
    // N private chats. (Reverses the per-(channel×user) split from PR #64; see
    // src/cwd-resolver.ts header. Space isolation is implicit: one bot = one
    // space = one process with its own dataDir/cwdBase/memoryBase.)
    //
    // channel_id IS the group's identity here, so a missing one is unroutable —
    // never fall back to '' (that would collapse every channel-less group message
    // into ONE shared session across unrelated channels, leaking history/memory
    // between them). Fail loud instead; route() treats the throw as a drop.
    if (!msg.channel_id) {
      throw new Error('Group message has no channel_id — cannot derive a session key');
    }
    return msg.channel_id;
  }

  /**
   * Extract spaceId from channel_id.
   * DM format: s{spaceId}_{uid1}@s{spaceId}_{uid2}
   * Group format: s{spaceId}_{groupNo} (but groups already use channel_id in key)
   */
  private extractSpaceId(msg: BotMessage): string {
    // For groups, channel_id already provides isolation
    if (this.isGroupLike(msg.channel_type)) return "";
    // DM: try from_uid first (format: s{spaceId}_{peerId})
    const uid = msg.from_uid;
    if (uid.startsWith("s")) {
      const lastUnderscore = uid.lastIndexOf("_");
      if (lastUnderscore > 0) {
        return uid.substring(1, lastUnderscore);
      }
    }
    // DM compound: s{spaceId}_{uid1}@s{spaceId}_{uid2}
    const channelId = msg.channel_id;
    if (channelId && channelId.startsWith("s")) {
      const atIdx = channelId.indexOf("@");
      const firstPart = atIdx > 0 ? channelId.substring(0, atIdx) : channelId;
      if (firstPart.startsWith("s")) {
        const lastUnderscore = firstPart.lastIndexOf("_");
        if (lastUnderscore > 0) {
          return firstPart.substring(1, lastUnderscore);
        }
      }
    }
    return "";
  }

  private isBlockedBot(uid: string): boolean {
    return this.config.botBlocklist?.includes(uid) ?? false;
  }

  /**
   * G14: Heuristic bot detection. Octo bot uids conventionally end in `_bot`.
   * This is NOT a perfect check — a human could pick that suffix — but it
   * catches the common case where a bot DMs another bot and triggers an
   * uncontrolled response loop. Bots whitelisted in `allowedBotUids` bypass
   * this gate.
   */
  private looksLikeBot(uid: string): boolean {
    if (this.knownBotUids.has(uid)) return true;
    if (uid.endsWith('_bot')) return true;
    return false;
  }

  private isAllowedBot(uid: string): boolean {
    return this.config.allowedBotUids?.includes(uid) ?? false;
  }

  private isGroupLike(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;
  }

  /**
   * Allowlist of channel types we actually converse on: DM, Group, and
   * CommunityTopic. Octo also emits system/command channels (e.g. channel_type
   * 8 "systemcmdonline" on connect) which are NOT user conversations — those
   * must be dropped, otherwise they fall through the DM/group gates and get
   * answered with an unsolicited LLM reply. Found in live deployment (#68).
   */
  private isSupportedChannel(channelType: ChannelType | undefined): boolean {
    return channelType === ChannelType.DM || this.isGroupLike(channelType);
  }

  private isMentioned(msg: BotMessage): boolean {
    const mention = msg.payload.mention;
    if (!mention) return false;
    if (mention.uids?.includes(this.robotId)) return true;
    // Note: mention.all is a humans-only signal (@所有人), bots do NOT respond.
    if (mention.ais) return true;
    return false;
  }

  /**
   * #115: True for a GENUINE in-process cron fire — `payload._cronFire` AND a
   * matching per-process nonce. Such messages bypass the group @mention gate
   * (owner-gated at creation, bound to this session). A forged inbound payload
   * can set `_cronFire` but not the secret nonce, so it does not pass. Real
   * inbound messages never carry the marker.
   */
  private isCronFire(msg: BotMessage): boolean {
    return isAuthenticCronFire(msg.payload);
  }

  private async processMessage(msg: BotMessage, key: string): Promise<RouteResult | null> {
    // Skip messages from self.
    if (msg.from_uid === this.robotId) return null;

    // Drop anything that isn't a real conversation channel (DM / group /
    // community topic). Octo emits system/command channels (e.g. channel_type 8
    // "systemcmdonline" on connect) that otherwise slip past the DM/group gates
    // and get an unsolicited reply (#68).
    if (!this.isSupportedChannel(msg.channel_type)) return null;

    // Skip stream update messages (G21) — only process final (non-stream) messages.
    // When streamOn is true, this is a partial update of an ongoing stream; the final
    // message arrives with streamOn=false and contains the complete content.
    if (msg.streamOn) return null;

    // DM blocklist filter.
    if (msg.channel_type === ChannelType.DM && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    // G14: DM from anything that looks like a bot — silently drop unless
    // explicitly whitelisted. Prevents bot↔bot reply loops.
    if (
      msg.channel_type === ChannelType.DM &&
      this.looksLikeBot(msg.from_uid) &&
      !this.isAllowedBot(msg.from_uid)
    ) {
      return null;
    }

    // Group: drop messages from other bots (blocklisted or self) entirely.
    if (this.isGroupLike(msg.channel_type) && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    // G14: Group messages from bot-looking uids — only respond if explicitly
    // @-mentioned. The mention gate below already enforces this, but bots in
    // the blocklist (above) get hard-dropped without even checking mentions.

    // Group mention gate — skip unless mentioned OR in mention-free group (G12).
    // #115: cron-fired synthetic messages bypass the @mention requirement — they
    // were created (owner-gated) and bound to this session; there's no human to
    // @-mention the bot at fire time. Rate limiting below still applies.
    if (this.isGroupLike(msg.channel_type) && !this.isMentioned(msg) && !this.isCronFire(msg)) {
      // G12: Check if this group is in the mention-free list
      const isMentionFree = this.config.mentionFreeGroups?.includes(msg.channel_id ?? '') ?? false;
      if (!isMentionFree) {
        return null;
      }
      // Multi-bot loop guard: in a mention-free group there is no @-mention gate
      // to stop one bot from replying to another bot's plain-text message. Drop
      // messages from known/bot-looking uids (unless explicitly whitelisted) so
      // two bots in the same mention-free room cannot enter an unbounded reply
      // loop. An @-mention still goes through (handled by the branch above).
      if (this.looksLikeBot(msg.from_uid) && !this.isAllowedBot(msg.from_uid)) {
        return null;
      }
    }

    // Skip system events (group join/leave, etc.) — no user-facing reply needed.
    if (msg.payload.event) return null;

    // Rate limit check BEFORE non-text check — prevents DM spam of non-text
    // messages from bypassing rate limiting entirely.
    // G20 fix: peek all three buckets without consuming; only consume on full
    // pass. On block, attach notified state to the actual blocking bucket so
    // the debounce reply doesn't spam when a different bucket has tokens.
    // #115: cron fires skip the rate limit — a scheduler-fired task is an
    // operator-scheduled action (already bounded by the cron interval), not
    // user spam. Without this a fire that lands while the owner's bucket is
    // exhausted would be silently dropped while its nextRun has already advanced.
    if (!this.isCronFire(msg)) {
      const blocker = this.checkAllRateLimits(key, msg.from_uid);
      if (blocker) {
        if (!blocker.notified) {
          blocker.notified = true;
          await this.replySafe(msg, '请稍后再试');
        }
        return {
          sessionKey: key,
          shouldProcess: false,
          message: msg,
          rejectionReason: 'rate_limited',
        };
      }
    }

    // G1: All payload types are now resolved by inbound.resolveContent in
    // handleMessage. The router only filters rate limits, size, and bot
    // loops — type-specific handling lives in the pipeline.

    // Q10: Reject messages exceeding content length limit (text only — media
    // URLs are bounded by their own size and rendered via resolveContent).
    const content = msg.payload.content ?? '';
    if (
      msg.payload.type === MessageType.Text &&
      Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES
    ) {
      await this.replySafe(msg, '消息过长，请缩短后重试');
      return {
        sessionKey: key,
        shouldProcess: false,
        message: msg,
        rejectionReason: 'oversized',
      };
    }

    // G13: Strip leading @botname from group TEXT messages for cleaner LLM input.
    // For non-text payloads (images, files, etc.) cleanContent stays undefined
    // so the pipeline falls back to the resolveContent rendering instead of an
    // empty string.
    let cleanContent: string | undefined;
    if (msg.payload.type === MessageType.Text) {
      cleanContent = content;
      if (this.isGroupLike(msg.channel_type)) {
        const mention = msg.payload.mention;
        // Path 1: entities-based removal (precise offset/length).
        if (mention?.entities && Array.isArray(mention.entities)) {
          const botEntity = mention.entities.find(
            (e: MentionEntity) => e.uid === this.robotId && e.offset === 0,
          );
          if (botEntity && typeof botEntity.length === 'number') {
            cleanContent = content.substring(botEntity.length).trimStart();
          }
        }
        // Path 2: regex fallback — only when the bot was explicitly @mentioned.
        // In mention-free groups (G12) where the bot wasn't @'d, do NOT touch
        // the message — a leading @ is addressed to someone else.
        if (cleanContent === content && this.isMentioned(msg)) {
          cleanContent = content.replace(/^@\S+\s*/, '').trimStart();
        }
        // If stripping emptied the content, keep original.
        if (!cleanContent) cleanContent = content;
      }
    }

    return { sessionKey: key, shouldProcess: true, message: msg, cleanContent };
  }

  /**
   * G20 fix: Check all three rate limits (global, per-session, per-user) in
   * one pass. Refills all three buckets, then either consumes 1 token from
   * each (when all pass) or returns the blocking bucket (when any fails).
   *
   * Returns null on success (tokens consumed), or the blocking bucket on
   * failure (no tokens consumed). The caller uses the blocking bucket's
   * `notified` flag to debounce the "请稍后再试" reply per-bucket, so a user
   * blocked by per-user limit doesn't get spammed when their per-session
   * bucket still has tokens.
   */
  private checkAllRateLimits(key: string, uid: string): TokenBucket | null {
    this.cleanStaleBuckets();

    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    const globalMax = maxPerMinute * GLOBAL_RATE_MULTIPLIER;

    const globalBucket = this.getOrCreateGlobalBucket(now, globalMax);
    // Per-participant session bucket: key by session AND uid. For a group the
    // sessionKey is the channel_id (shared), so keying the rate bucket by
    // sessionKey alone would collapse the WHOLE room into one maxPerMinute quota
    // (the 6th message/min from ANY member blocked). Including uid restores a
    // per-member per-channel quota — matching the pre-shared-session behavior —
    // while the global + per-user buckets still bound abuse. For a DM the
    // sessionKey already embeds the peer, so this is just per-peer. Joined with a
    // newline (never present in a uid/key) so distinct pairs can't alias.
    const sessionBucketKey = `${key}\n${uid}`;
    const sessionBucket = this.getOrCreateBucket(this.tokenBuckets, sessionBucketKey, now, maxPerMinute);
    const userBucket = this.getOrCreateBucket(this.userBuckets, uid, now, maxPerMinute);

    this.refillBucket(globalBucket, now, globalMax);
    this.refillBucket(sessionBucket, now, maxPerMinute);
    this.refillBucket(userBucket, now, maxPerMinute);

    // Check in priority order: global → per-user → per-session.
    // Per-user before per-session so a user blocked across groups gets a
    // consistent debounce target instead of one per session bucket.
    if (globalBucket.tokens < 1) return globalBucket;
    if (userBucket.tokens < 1) return userBucket;
    if (sessionBucket.tokens < 1) return sessionBucket;

    // All pass — consume one token from each, and clear notified flags so
    // future blocks get a fresh debounce window.
    globalBucket.tokens -= 1;
    sessionBucket.tokens -= 1;
    userBucket.tokens -= 1;
    globalBucket.notified = false;
    sessionBucket.notified = false;
    userBucket.notified = false;
    return null;
  }

  private getOrCreateBucket(
    map: Map<string, TokenBucket>,
    key: string,
    now: number,
    capacity: number,
  ): TokenBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now, notified: false };
      map.set(key, bucket);
    }
    return bucket;
  }

  private getOrCreateGlobalBucket(now: number, capacity: number): TokenBucket {
    if (!this.globalBucket) {
      this.globalBucket = { tokens: capacity, lastRefill: now, notified: false };
    }
    return this.globalBucket;
  }

  private refillBucket(bucket: TokenBucket, now: number, capacity: number): void {
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  /** Remove token buckets that haven't been used in 5 minutes. */
  private cleanStaleBuckets(): void {
    const now = Date.now();
    for (const [key, bucket] of this.tokenBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.tokenBuckets.delete(key);
      }
    }
    for (const [uid, bucket] of this.userBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.userBuckets.delete(uid);
      }
    }
  }

  private async replySafe(msg: BotMessage, content: string): Promise<void> {
    if (!msg.channel_id || msg.channel_type === undefined) return;
    try {
      await sendMessage({
        apiUrl: this.config.apiUrl,
        botToken: this.config.botToken,
        channelId: msg.channel_id,
        channelType: msg.channel_type,
        content,
      });
    } catch (err) {
      console.error(`session-router: reply failed: ${String(err)}`);
    }
  }
}

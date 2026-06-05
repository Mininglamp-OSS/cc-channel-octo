/**
 * Session Router — routing + concurrency control + mention gate + rate limiting.
 */

import type { Config } from './config.js';
import type { BotMessage } from './octo/types.js';
import { ChannelType, MessageType } from './octo/types.js';
import { sendMessage } from './octo/api.js';

export interface RouteResult {
  sessionKey: string;
  shouldProcess: boolean;
  message: BotMessage;
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
  async routeAndHandle(
    msg: BotMessage,
    handler: (result: RouteResult) => Promise<void>,
  ): Promise<void> {
    const key = this.sessionKey(msg);
    await this.withSessionLock(key, async () => {
      const result = await this.processMessage(msg, key);
      if (result && result.shouldProcess) {
        await handler(result);
      }
    });
  }

  async route(msg: BotMessage): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    return this.withSessionLock(key, () => this.processMessage(msg, key));
  }

  sessionKey(msg: BotMessage): string {
    if (msg.channel_type === ChannelType.DM) {
      return msg.from_uid;
    }
    return `${msg.channel_id ?? ''}:${msg.from_uid}`;
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

  private isMentioned(msg: BotMessage): boolean {
    const mention = msg.payload.mention;
    if (!mention) return false;
    if (mention.uids?.includes(this.robotId)) return true;
    // Note: mention.all is a humans-only signal (@所有人), bots do NOT respond.
    if (mention.ais) return true;
    return false;
  }

  private async processMessage(msg: BotMessage, key: string): Promise<RouteResult | null> {
    // Skip messages from self.
    if (msg.from_uid === this.robotId) return null;

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

    // Group mention gate.
    if (this.isGroupLike(msg.channel_type) && !this.isMentioned(msg)) {
      return null;
    }

    // Skip system events (group join/leave, etc.) — no user-facing reply needed.
    if (msg.payload.event) return null;

    // Rate limit check BEFORE non-text check — prevents DM spam of non-text
    // messages from bypassing rate limiting entirely.
    // G20: enforce both per-session and per-user limits. Per-user prevents a
    // single user from circumventing the limit by messaging across groups.
    if (
      !this.checkGlobalRateLimit() ||
      !this.checkRateLimit(key) ||
      !this.checkUserRateLimit(msg.from_uid)
    ) {
      // Debounce: only notify once per rate-limit window to avoid reply spam.
      const bucket = this.tokenBuckets.get(key);
      if (bucket && !bucket.notified) {
        bucket.notified = true;
        await this.replySafe(msg, '请稍后再试');
      }
      return { sessionKey: key, shouldProcess: false, message: msg };
    }

    // Non-text message → reply with notice.
    if (msg.payload.type !== MessageType.Text) {
      await this.replySafe(msg, '暂不支持此类消息，请发送文字');
      return { sessionKey: key, shouldProcess: false, message: msg };
    }

    // Q10: Reject messages exceeding content length limit.
    const content = msg.payload.content ?? '';
    if (Buffer.byteLength(content, 'utf-8') > MAX_CONTENT_BYTES) {
      await this.replySafe(msg, '消息过长，请缩短后重试');
      return { sessionKey: key, shouldProcess: false, message: msg };
    }

    return { sessionKey: key, shouldProcess: true, message: msg };
  }

  private checkRateLimit(key: string): boolean {
    this.cleanStaleBuckets();

    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    let bucket = this.tokenBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxPerMinute, lastRefill: now, notified: false };
      this.tokenBuckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * maxPerMinute;
    bucket.tokens = Math.min(maxPerMinute, bucket.tokens + refill);
    bucket.lastRefill = now;

    // Reset notification flag when tokens have been refilled above threshold
    if (bucket.tokens >= 1) {
      bucket.notified = false;
    }

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * G20: Per-user rate limit independent of channel. Same limit as per-session
   * — prevents a user from multiplying their effective quota by spreading
   * messages across groups.
   */
  private checkUserRateLimit(uid: string): boolean {
    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    let bucket = this.userBuckets.get(uid);
    if (!bucket) {
      bucket = { tokens: maxPerMinute, lastRefill: now, notified: false };
      this.userBuckets.set(uid, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * maxPerMinute;
    bucket.tokens = Math.min(maxPerMinute, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Global rate limit across all sessions (10x per-session limit). */
  private checkGlobalRateLimit(): boolean {
    const now = Date.now();
    const globalMax = this.config.rateLimit.maxPerMinute * GLOBAL_RATE_MULTIPLIER;
    if (!this.globalBucket) {
      this.globalBucket = { tokens: globalMax, lastRefill: now, notified: false };
    }
    const elapsed = now - this.globalBucket.lastRefill;
    const refill = (elapsed / 60_000) * globalMax;
    this.globalBucket.tokens = Math.min(globalMax, this.globalBucket.tokens + refill);
    this.globalBucket.lastRefill = now;
    if (this.globalBucket.tokens < 1) return false;
    this.globalBucket.tokens -= 1;
    return true;
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

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

export class SessionRouter {
  private readonly config: Config;
  private readonly robotId: string;
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();

  constructor(config: Config, robotId: string) {
    this.config = config;
    this.robotId = robotId;
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

  /**
   * Execute fn under the per-session lock. Ensures only one pipeline runs
   * at a time per session key, preventing history interleaving.
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

  private isBlockedBot(uid: string): boolean {
    return this.config.botBlocklist?.includes(uid) ?? false;
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

    // Group: drop messages from other bots (blocklisted or self) entirely.
    if (this.isGroupLike(msg.channel_type) && this.isBlockedBot(msg.from_uid)) {
      return null;
    }

    // Group mention gate.
    if (this.isGroupLike(msg.channel_type) && !this.isMentioned(msg)) {
      return null;
    }

    // Skip system events (group join/leave, etc.) — no user-facing reply needed.
    if (msg.payload.event) return null;

    // Rate limit check BEFORE non-text check — prevents DM spam of non-text
    // messages from bypassing rate limiting entirely.
    if (!this.checkRateLimit(key)) {
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

  /** Remove token buckets that haven't been used in 5 minutes. */
  private cleanStaleBuckets(): void {
    const now = Date.now();
    for (const [key, bucket] of this.tokenBuckets) {
      if (now - bucket.lastRefill > BUCKET_STALE_MS) {
        this.tokenBuckets.delete(key);
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

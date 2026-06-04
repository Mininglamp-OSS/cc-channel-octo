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
}

export class SessionRouter {
  private readonly config: Config;
  private readonly robotId: string;
  private readonly inboundQueues = new Map<string, Promise<void>>();
  private readonly tokenBuckets = new Map<string, TokenBucket>();

  constructor(config: Config, robotId: string) {
    this.config = config;
    this.robotId = robotId;
  }

  async route(msg: BotMessage): Promise<RouteResult | null> {
    const key = this.sessionKey(msg);
    const prev = this.inboundQueues.get(key) ?? Promise.resolve();
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    this.inboundQueues.set(key, gate);

    try {
      await prev;
      return await this.processMessage(msg, key);
    } finally {
      resolveGate();
      if (this.inboundQueues.get(key) === gate) {
        this.inboundQueues.delete(key);
      }
    }
  }

  private sessionKey(msg: BotMessage): string {
    if (msg.channel_type === ChannelType.DM) {
      return msg.from_uid;
    }
    return `${msg.channel_id ?? ''}:${msg.from_uid}`;
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
    if (mention.all) return true;
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

    // Non-text message → reply with notice.
    if (msg.payload.type !== MessageType.Text) {
      await this.replySafe(msg, '暂不支持此类消息，请发送文字');
      return { sessionKey: key, shouldProcess: false, message: msg };
    }

    // Rate limit.
    if (!this.checkRateLimit(key)) {
      await this.replySafe(msg, '请稍后再试');
      return { sessionKey: key, shouldProcess: false, message: msg };
    }

    return { sessionKey: key, shouldProcess: true, message: msg };
  }

  private checkRateLimit(key: string): boolean {
    const now = Date.now();
    const maxPerMinute = this.config.rateLimit.maxPerMinute;
    let bucket = this.tokenBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: maxPerMinute, lastRefill: now };
      this.tokenBuckets.set(key, bucket);
    }
    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / 60_000) * maxPerMinute;
    bucket.tokens = Math.min(maxPerMinute, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
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

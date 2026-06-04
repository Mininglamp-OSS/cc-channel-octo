import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Octo API before importing SessionRouter
vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

import { SessionRouter } from '../session-router.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';
import { sendMessage } from '../octo/api.js';

const ROBOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: ['blocked-bot-1'],
    ...overrides,
  };
}

function makeMsg(overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: 'user-1',
    channel_id: 'group-1',
    channel_type: ChannelType.Group,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'hello' },
    ...overrides,
  };
}

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID);
  });

  // --- Session key ---

  it('DM session key = from_uid', () => {
    const msg = makeMsg({ channel_type: ChannelType.DM, from_uid: 'u1' });
    expect(router.sessionKey(msg)).toBe('u1');
  });

  it('Group session key = channel_id:from_uid', () => {
    const msg = makeMsg({ channel_type: ChannelType.Group, channel_id: 'g1', from_uid: 'u1' });
    expect(router.sessionKey(msg)).toBe('g1:u1');
  });

  // --- Self-skip ---

  it('skips messages from self', async () => {
    const msg = makeMsg({ from_uid: ROBOT_ID, channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Blocklist ---

  it('skips DM from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('skips group message from blocklisted bot', async () => {
    const msg = makeMsg({
      from_uid: 'blocked-bot-1',
      channel_type: ChannelType.Group,
      payload: {
        type: MessageType.Text,
        content: 'hi',
        mention: { uids: [ROBOT_ID] },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- Mention gate ---

  it('passes DM without mention gate', async () => {
    const msg = makeMsg({ channel_type: ChannelType.DM });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.uids includes robotId', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { uids: [ROBOT_ID] } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('passes group message when mention.ais is truthy', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { ais: 1 } },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(true);
  });

  it('REJECTS group message when only mention.all is set (humans-only)', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi', mention: { all: 1 } },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  it('rejects group message with no mention at all', async () => {
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: 'hi' },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
  });

  // --- System events ---

  it('silently skips system events (payload.event)', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: {
        type: MessageType.Text,
        content: '',
        event: { type: 'group_md_updated' },
      },
    });
    const result = await router.route(msg);
    expect(result).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // --- Non-text message ---

  it('replies to non-text message and returns shouldProcess=false', async () => {
    const msg = makeMsg({
      channel_type: ChannelType.DM,
      payload: { type: MessageType.Image },
    });
    const result = await router.route(msg);
    expect(result).not.toBeNull();
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '暂不支持此类消息，请发送文字' }),
    );
  });

  // --- Rate limiting ---

  it('passes first N requests within limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 3 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    for (let i = 0; i < 3; i++) {
      const msg = makeMsg({ message_id: String(i), channel_type: ChannelType.DM });
      const result = await router.route(msg);
      expect(result!.shouldProcess).toBe(true);
    }
  });

  it('rejects requests exceeding rate limit', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    // Consume tokens
    await router.route(makeMsg({ message_id: '1', channel_type: ChannelType.DM }));
    await router.route(makeMsg({ message_id: '2', channel_type: ChannelType.DM }));

    // Should be rate limited
    const result = await router.route(makeMsg({ message_id: '3', channel_type: ChannelType.DM }));
    expect(result!.shouldProcess).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: '请稍后再试' }),
    );
  });

  // --- Serial queue ---

  it('processes same session key sequentially', async () => {
    const order: number[] = [];
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 100 } });
    router = new SessionRouter(cfg, ROBOT_ID);

    const promises = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      promises.push(
        router.route(makeMsg({ message_id: String(idx), channel_type: ChannelType.DM })).then(() => {
          order.push(idx);
        }),
      );
    }
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

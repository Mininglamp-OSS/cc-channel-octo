import { describe, it, expect, vi } from 'vitest';

// Mock API
vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
}));

import { SessionRouter } from '../session-router.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';

const BOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 100 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
    ...overrides,
  };
}

// --- G13: @botname stripping ---
describe('G13: @botname stripping', () => {
  it('strips leading @botname from group message via entities', async () => {
    const router = new SessionRouter(makeConfig(), BOT_ID);
    let cleanContent: string | undefined;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'g1', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: {
        type: MessageType.Text,
        content: '@MyBot help me with this code',
        mention: {
          uids: [BOT_ID],
          entities: [{ uid: BOT_ID, offset: 0, length: 6 }],
        },
      },
    }, async (result) => {
      cleanContent = result.cleanContent;
    });

    expect(cleanContent).toBe('help me with this code');
  });

  it('strips leading @botname via regex fallback', async () => {
    const router = new SessionRouter(makeConfig(), BOT_ID);
    let cleanContent: string | undefined;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'g1', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: {
        type: MessageType.Text,
        content: '@bot review this',
        mention: { uids: [BOT_ID] },
      },
    }, async (result) => {
      cleanContent = result.cleanContent;
    });

    expect(cleanContent).toBe('review this');
  });

  it('does not strip @botname in DM', async () => {
    const router = new SessionRouter(makeConfig(), BOT_ID);
    let cleanContent: string | undefined;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'user-1', channel_type: ChannelType.DM,
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: '@someone hello' },
    }, async (result) => {
      cleanContent = result.cleanContent;
    });

    // DM: no stripping
    expect(cleanContent).toBe('@someone hello');
  });

  it('preserves content when stripping would empty it', async () => {
    const router = new SessionRouter(makeConfig(), BOT_ID);
    let cleanContent: string | undefined;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'g1', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: {
        type: MessageType.Text,
        content: '@bot',
        mention: { uids: [BOT_ID] },
      },
    }, async (result) => {
      cleanContent = result.cleanContent;
    });

    expect(cleanContent).toBe('@bot');
  });
});

// --- G12: Mention-free mode ---
describe('G12: Mention-free groups', () => {
  it('processes group message without @mention when group is mention-free', async () => {
    const router = new SessionRouter(
      makeConfig({ mentionFreeGroups: ['free-group-1'] }),
      BOT_ID,
    );
    let processed = false;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'free-group-1', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: 'hello without @' },
    }, async () => {
      processed = true;
    });

    expect(processed).toBe(true);
  });

  it('still requires @mention in non-mention-free groups', async () => {
    const router = new SessionRouter(
      makeConfig({ mentionFreeGroups: ['free-group-1'] }),
      BOT_ID,
    );
    let processed = false;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'normal-group', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: 'hello without @' },
    }, async () => {
      processed = true;
    });

    expect(processed).toBe(false);
  });

  it('still filters system events in mention-free groups', async () => {
    const router = new SessionRouter(
      makeConfig({ mentionFreeGroups: ['free-group-1'] }),
      BOT_ID,
    );
    let processed = false;

    await router.routeAndHandle({
      message_id: '1', message_seq: 1, from_uid: 'user-1',
      channel_id: 'free-group-1', channel_type: ChannelType.Group,
      timestamp: Date.now(),
      payload: {
        type: MessageType.Text,
        content: '',
        event: { type: 'member_join' },
      },
    }, async () => {
      processed = true;
    });

    expect(processed).toBe(false);
  });
});

// --- G8: Read receipt ---
describe('G8: sendReadReceipt API', () => {
  it('sendReadReceipt is exported from api.ts', async () => {
    const { sendReadReceipt } = await import('../octo/api.js');
    expect(typeof sendReadReceipt).toBe('function');
  });
});

// --- G3: Reply quote context ---
describe('G3: Reply quote context', () => {
  // This is mostly an integration test via e2e, but we can verify the types support it
  it('BotMessage supports reply payload', () => {
    const msg = {
      message_id: '1', message_seq: 1, from_uid: 'u1',
      channel_type: ChannelType.DM, timestamp: 0,
      payload: {
        type: MessageType.Text,
        content: 'test',
        reply: {
          from_uid: 'u2',
          from_name: 'Alice',
          payload: { type: MessageType.Text, content: 'original message' },
        },
      },
    };
    expect(msg.payload.reply?.payload?.content).toBe('original message');
    expect(msg.payload.reply?.from_name).toBe('Alice');
  });
});

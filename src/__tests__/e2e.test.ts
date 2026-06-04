/**
 * End-to-end smoke tests — simulate the complete message pipeline
 * without real WS connections or Claude API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks (hoisted before imports) ---

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  streamStart: vi.fn().mockResolvedValue('stream-001'),
  streamSend: vi.fn().mockResolvedValue(undefined),
  streamEnd: vi.fn().mockResolvedValue(undefined),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'bot-001',
    im_token: 'token',
    ws_url: 'ws://localhost',
    api_url: 'https://test.example.com',
    owner_uid: 'owner',
    owner_channel_id: 'ch-owner',
  }),
  generateClientMsgNo: vi.fn().mockReturnValue('client-msg-001'),
  fetchUserInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  return {
    ...original,
    buildPrompt: original.buildPrompt,
    queryAgent: vi.fn(),
  };
});

// --- Imports (after mocks) ---

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { buildPrompt, queryAgent } from '../agent-bridge.js';
import {
  sendMessage,
  sendTyping,
  streamStart,
  streamSend,
  streamEnd,
} from '../octo/api.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

// --- Constants ---

const BOT_ID = 'bot-001';
const USER_UID = 'user-001';
const GROUP_CHANNEL = 'group-ch-001';

// --- Helpers ---

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/test-project',
    dataDir: '/tmp/data',
    sdk: {
      allowedTools: ['Read', 'Glob', 'Grep'],
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: [],
    ...overrides,
  };
}

function makeDmMsg(content: string, overrides?: Partial<BotMessage>): BotMessage {
  return {
    message_id: `msg-${Date.now()}`,
    message_seq: 1,
    from_uid: USER_UID,
    from_name: 'TestUser',
    channel_id: USER_UID,
    channel_type: ChannelType.DM,
    timestamp: Math.floor(Date.now() / 1000),
    payload: { type: MessageType.Text, content },
    ...overrides,
  };
}

function makeGroupMsg(
  content: string,
  mentionBot = false,
  overrides?: Partial<BotMessage>,
): BotMessage {
  return {
    message_id: `msg-${Date.now()}`,
    message_seq: 1,
    from_uid: USER_UID,
    from_name: 'TestUser',
    channel_id: GROUP_CHANNEL,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content,
      mention: mentionBot ? { uids: [BOT_ID] } : undefined,
    },
    ...overrides,
  };
}

function mockQueryYield(...texts: string[]): void {
  (queryAgent as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
    for (const t of texts) {
      yield t;
    }
  });
}

/**
 * Simulate the handleMessage pipeline from index.ts.
 * Mirrors the real pipeline logic without importing the non-exported function.
 */
async function simulateMessage(
  msg: BotMessage,
  config: Config,
  store: SessionStore,
  router: SessionRouter,
  groupContext: GroupContext,
  streamRelay: StreamRelay,
): Promise<void> {
  const channelId = msg.channel_id ?? '';
  const channelType = msg.channel_type ?? ChannelType.DM;
  const isGroup =
    channelType === ChannelType.Group || channelType === ChannelType.CommunityTopic;

  let wasProcessed = false;
  await router.routeAndHandle(msg, async (result) => {
    wasProcessed = true;
    const { sessionKey } = result;

    store.getOrCreate(sessionKey, channelId, channelType);

    let contextStr = '';
    if (isGroup) {
      await groupContext.refreshMembers(channelId, config.apiUrl, config.botToken);
      contextStr = groupContext.buildContext(channelId);
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

    const userContent = msg.payload.content ?? '';
    const historyPrefix = store.buildHistoryPrefix(sessionKey, config.context.historyLimit);
    store.appendUser(sessionKey, userContent);

    const prompt = buildPrompt(historyPrefix, contextStr, userContent);
    const rawChunks = queryAgent(prompt, config);

    const collected: string[] = [];
    async function* teeChunks(): AsyncIterable<string> {
      for await (const chunk of rawChunks) {
        collected.push(chunk);
        yield chunk;
      }
    }

    await streamRelay.deliver(
      channelId,
      channelType,
      teeChunks(),
      config.apiUrl,
      config.botToken,
    );

    const fullResponse = collected.join('');
    if (fullResponse) {
      store.appendAssistant(sessionKey, fullResponse);
    }
  });

  if (
    !wasProcessed &&
    isGroup &&
    msg.payload.type === MessageType.Text &&
    msg.payload.content
  ) {
    groupContext.pushMessage(
      channelId,
      msg.from_uid,
      msg.from_name ?? msg.from_uid,
      msg.payload.content,
      msg.timestamp,
    );
  }
}

// --- Tests ---

describe('E2E smoke tests', () => {
  let adapter: DbAdapter;
  let store: SessionStore;
  let router: SessionRouter;
  let groupContext: GroupContext;
  let streamRelay: StreamRelay;
  let config: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    config = makeConfig();
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
    groupContext = new GroupContext(adapter, config.context.maxContextChars);
    streamRelay = new StreamRelay();
    router = new SessionRouter(config, BOT_ID);

    // Default mock: queryAgent yields a simple response
    mockQueryYield('Hello from Claude');
  });

  afterEach(() => {
    store.close();
  });

  // --- 1. DM text message happy path ---

  it('DM text message: processes and streams response + stores history', async () => {
    const msg = makeDmMsg('Hi there');
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    // queryAgent was called
    expect(queryAgent).toHaveBeenCalledTimes(1);
    const prompt = (queryAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('[Current message]\nHi there');

    // Stream output was sent
    expect(streamStart).toHaveBeenCalled();
    expect(streamEnd).toHaveBeenCalled();

    // Session history stored
    const history = store.buildHistoryPrefix(USER_UID, 40);
    expect(history).toContain('[user]: Hi there');
    expect(history).toContain('[assistant]: Hello from Claude');
  });

  // --- 2. Group @mention triggers processing ---

  it('Group @mention: triggers agent and stores history', async () => {
    const msg = makeGroupMsg('What is this code?', true);
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    // queryAgent was called
    expect(queryAgent).toHaveBeenCalledTimes(1);

    // Stream output was sent to group channel
    expect(streamStart).toHaveBeenCalled();

    // Session history stored (group session key = channel_id:from_uid)
    const sessionKey = `${GROUP_CHANNEL}:${USER_UID}`;
    const history = store.buildHistoryPrefix(sessionKey, 40);
    expect(history).toContain('[user]: What is this code?');
    expect(history).toContain('[assistant]: Hello from Claude');
  });

  // --- 3. Group non-@mention does NOT trigger ---

  it('Group non-@mention: caches context but does NOT call agent', async () => {
    const msg = makeGroupMsg('Just chatting', false);
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    // queryAgent should NOT be called
    expect(queryAgent).not.toHaveBeenCalled();

    // No stream output
    expect(streamStart).not.toHaveBeenCalled();

    // But message IS cached in group context
    const ctx = groupContext.buildContext(GROUP_CHANNEL);
    expect(ctx).toContain('TestUser：Just chatting');
  });

  // --- 4. Non-text message gets "unsupported" reply ---

  it('Non-text DM message: replies with unsupported notice', async () => {
    const msg = makeDmMsg('', {
      payload: { type: MessageType.Image, url: 'https://example.com/img.png' },
    });
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    // queryAgent should NOT be called
    expect(queryAgent).not.toHaveBeenCalled();

    // sendMessage called with unsupported notice
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '暂不支持此类消息，请发送文字',
      }),
    );
  });

  // --- 5. Rate limit rejection ---

  it('Rate limit: rejects messages beyond maxPerMinute', async () => {
    const limitedConfig = makeConfig({ rateLimit: { maxPerMinute: 2 } });
    router = new SessionRouter(limitedConfig, BOT_ID);

    // Send 3 messages rapidly (limit is 2)
    for (let i = 0; i < 3; i++) {
      mockQueryYield(`Response ${i}`);
      const msg = makeDmMsg(`Message ${i}`, { message_id: `msg-${i}` });
      await simulateMessage(msg, limitedConfig, store, router, groupContext, streamRelay);
    }

    // queryAgent called only for the first 2 messages
    expect(queryAgent).toHaveBeenCalledTimes(2);

    // Rate limit reply sent (debounced — only once)
    const sendMessageCalls = (sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const rateLimitReplies = sendMessageCalls.filter(
      (call) => (call[0] as Record<string, unknown>).content === '请稍后再试',
    );
    expect(rateLimitReplies.length).toBe(1);
  });

  // --- 6. Multi-turn history accumulates ---

  it('Multi-turn DM: history accumulates across messages', async () => {
    mockQueryYield('First reply');
    await simulateMessage(makeDmMsg('Hello'), config, store, router, groupContext, streamRelay);

    mockQueryYield('Second reply');
    await simulateMessage(makeDmMsg('Follow up'), config, store, router, groupContext, streamRelay);

    expect(queryAgent).toHaveBeenCalledTimes(2);

    // Second call should include history from first turn
    const secondPrompt = (queryAgent as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(secondPrompt).toContain('[Conversation history]');
    expect(secondPrompt).toContain('[user]: Hello');
    expect(secondPrompt).toContain('[assistant]: First reply');
    expect(secondPrompt).toContain('[Current message]\nFollow up');

    // Full history stored
    const history = store.buildHistoryPrefix(USER_UID, 40);
    expect(history).toContain('[user]: Hello');
    expect(history).toContain('[assistant]: First reply');
    expect(history).toContain('[user]: Follow up');
    expect(history).toContain('[assistant]: Second reply');
  });

  // --- 7. Bot self-message is filtered ---

  it('Bot self-message: filtered by router, not processed', async () => {
    const msg = makeDmMsg('I am the bot', { from_uid: BOT_ID });
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    expect(queryAgent).not.toHaveBeenCalled();
    expect(streamStart).not.toHaveBeenCalled();
  });

  // --- 8. Group context not duplicated in prompt ---

  it('Group @mention: current message not in group context section', async () => {
    // Pre-populate some group context
    groupContext.pushMessage(GROUP_CHANNEL, 'other-user', 'Alice', 'Previous message', Date.now());

    const msg = makeGroupMsg('My question', true);
    await simulateMessage(msg, config, store, router, groupContext, streamRelay);

    const prompt = (queryAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Group context should have the previous message but NOT the current one
    expect(prompt).toContain('[Group context]');
    expect(prompt).toContain('Alice：Previous message');
    // Current message appears only in [Current message]
    expect(prompt).toContain('[Current message]\nMy question');

    // Count occurrences of "My question" — should appear exactly once
    const occurrences = prompt.split('My question').length - 1;
    expect(occurrences).toBe(1);
  });
});

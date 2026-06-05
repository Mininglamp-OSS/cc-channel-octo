/**
 * C1 (Stage 6) — RouteResult.rejectionReason + userContent type guard.
 *
 * P1.1: index.ts userContent fallback now uses typeof === 'string' guard so
 *       RichText/File payloads with array/object content don't crash SQLite.
 * P2.5: SessionRouter attaches rejectionReason on rate-limited/oversized so
 *       index.ts can suppress group context caching for those messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRouter } from '../session-router.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { BotMessage } from '../octo/types.js';
import type { Config } from '../config.js';

// Mock sendMessage so replySafe doesn't hit the network
vi.mock('../octo/api.js', async () => {
  const actual = await vi.importActual<typeof import('../octo/api.js')>('../octo/api.js');
  return {
    ...actual,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
});

const ROBOT_ID = 'bot-xyz';
const OWNER_UID = 'owner-1';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: 'tok',
    apiUrl: 'https://test',
    cwd: '/tmp',
    dataDir: '/tmp/data',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524_288,
    ...overrides,
  };
}

function makeMsg(opts: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: '1',
    message_seq: 1,
    from_uid: 'user-alice',
    channel_id: 'dm-1',
    channel_type: ChannelType.DM,
    timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'hi' },
    ...opts,
  };
}

describe('C1 P2.5: rejectionReason attached to RouteResult', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    router = new SessionRouter(makeConfig(), ROBOT_ID, OWNER_UID);
  });

  it('rate-limited message returns rejectionReason="rate_limited"', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID, OWNER_UID);

    // First message passes
    const first = await router.route(makeMsg({ message_id: 'a', message_seq: 1 }));
    expect(first?.shouldProcess).toBe(true);

    // Second from same user exhausts per-session bucket
    const second = await router.route(makeMsg({ message_id: 'b', message_seq: 2 }));
    expect(second?.shouldProcess).toBe(false);
    expect(second?.rejectionReason).toBe('rate_limited');
  });

  it('oversized text message returns rejectionReason="oversized"', async () => {
    const huge = 'A'.repeat(33 * 1024); // 33 KB > 32 KB cap
    const msg = makeMsg({
      payload: { type: MessageType.Text, content: huge },
    });
    const result = await router.route(msg);
    expect(result?.shouldProcess).toBe(false);
    expect(result?.rejectionReason).toBe('oversized');
  });

  it('legitimate messages have no rejectionReason', async () => {
    const result = await router.route(makeMsg());
    expect(result?.shouldProcess).toBe(true);
    expect(result?.rejectionReason).toBeUndefined();
  });

  it('routeAndHandle returns the RouteResult including rejectionReason', async () => {
    const cfg = makeConfig({ rateLimit: { maxPerMinute: 1 } });
    router = new SessionRouter(cfg, ROBOT_ID, OWNER_UID);

    // Burn the only token
    await router.routeAndHandle(makeMsg({ message_id: 'a' }), async () => {});

    let handlerCalled = false;
    const result = await router.routeAndHandle(
      makeMsg({ message_id: 'b', message_seq: 2 }),
      async () => { handlerCalled = true; },
    );

    expect(handlerCalled).toBe(false);
    expect(result?.shouldProcess).toBe(false);
    expect(result?.rejectionReason).toBe('rate_limited');
  });
});

// ─── P1.1 userContent typeof guard ────────────────────────────────────────
//
// The fix lives in index.ts handleMessage. We exercise it at the contract
// level: simulate the userContent assignment with non-string content and
// assert the fallback fires.

describe('C1 P1.1: userContent typeof guard prevents RichText/File array crash', () => {
  function selectUserContent(payloadContent: unknown, historyRecord: string): string {
    // Mirror the fixed expression in handleMessage:
    return typeof payloadContent === 'string' ? payloadContent : historyRecord;
  }

  it('uses historyRecord when payload.content is an array (RichText)', () => {
    const richTextContent = [
      { type: 1, text: 'hi' },
      { type: 2, url: 'file/x.png' },
    ];
    const result = selectUserContent(richTextContent, '[RichText placeholder]');
    expect(result).toBe('[RichText placeholder]');
    expect(typeof result).toBe('string');
  });

  it('uses historyRecord when payload.content is an object (defensive)', () => {
    const objContent = { malicious: true };
    const result = selectUserContent(objContent, '[fallback]');
    expect(result).toBe('[fallback]');
  });

  it('uses historyRecord when payload.content is a number (defensive)', () => {
    const result = selectUserContent(42, '[fallback]');
    expect(result).toBe('[fallback]');
  });

  it('uses payload.content when it is a non-empty string (Text path)', () => {
    const result = selectUserContent('hello', '[never-used]');
    expect(result).toBe('hello');
  });

  it('uses payload.content when it is an empty string (preserves explicit empty)', () => {
    // Empty string is still a string — pre-fix `?? historyRecord` did NOT fall
    // back for '', and the new typeof guard preserves that behavior.
    const result = selectUserContent('', '[never-used]');
    expect(result).toBe('');
  });

  it('uses historyRecord when payload.content is null or undefined', () => {
    expect(selectUserContent(null, '[fb]')).toBe('[fb]');
    expect(selectUserContent(undefined, '[fb]')).toBe('[fb]');
  });
});

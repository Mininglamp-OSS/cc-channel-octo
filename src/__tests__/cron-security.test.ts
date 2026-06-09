/**
 * #115: cron security/routing — the _cronFire mention-gate bypass.
 *
 * Verifies a cron-fired synthetic message is PROCESSED in a group without an
 * @mention, while an ordinary un-@'d group message is still dropped. (The
 * owner-gate on cron CREATION is covered in cron-tool.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
}));

import { SessionRouter } from '../session-router.js';
import type { BotMessage } from '../octo/types.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { Config } from '../config.js';

const ROBOT_ID = 'bot-001';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 't', apiUrl: 'https://t.example.com', cwd: '/tmp', dataDir: '/tmp/d',
    sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: [] },
    rateLimit: { maxPerMinute: 60 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    ...overrides,
  };
}
function groupMsg(over?: Partial<BotMessage>): BotMessage {
  return {
    message_id: '1', message_seq: 1, from_uid: 'user-1',
    channel_id: 'group-1', channel_type: ChannelType.Group, timestamp: Date.now(),
    payload: { type: MessageType.Text, content: 'do the thing' }, ...over,
  };
}

describe('cron mention-gate bypass (#115)', () => {
  let router: SessionRouter;
  beforeEach(() => { vi.clearAllMocks(); router = new SessionRouter(makeConfig(), ROBOT_ID); });

  it('ordinary un-@-mentioned group message is dropped', async () => {
    const r = await router.route(groupMsg());
    expect(r).toBeNull();
  });

  it('cron-fired group message (no @mention) is PROCESSED', async () => {
    const r = await router.route(groupMsg({
      payload: { type: MessageType.Text, content: 'do the thing', _cronFire: true },
    }));
    expect(r).not.toBeNull();
    expect(r!.shouldProcess).toBe(true);
  });

  it('cron-fired DM message is PROCESSED (DM has no gate anyway)', async () => {
    const r = await router.route(groupMsg({
      channel_type: ChannelType.DM, channel_id: undefined, from_uid: 'peer-9',
      payload: { type: MessageType.Text, content: 'remind', _cronFire: true },
    }));
    expect(r).not.toBeNull();
    expect(r!.shouldProcess).toBe(true);
  });

  it('payload without _cronFire (false/absent) stays gated', async () => {
    const r = await router.route(groupMsg({
      payload: { type: MessageType.Text, content: 'x', _cronFire: false },
    }));
    expect(r).toBeNull();
  });
});

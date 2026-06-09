/**
 * #115: cron integration — a synthetic cron-fired message through the REAL
 * handleMessage pipeline. Mirrors e2e.test.ts's mock setup (octo/api,
 * agent-bridge.queryAgent, media-inbound stubbed) so we exercise routing +
 * dispatch without network or a live SDK.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../octo/api.js', () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendReadReceipt: vi.fn().mockResolvedValue(undefined),
  getChannelMessages: vi.fn().mockResolvedValue([]),
  getUploadCredentials: vi.fn().mockResolvedValue({}),
  getGroupMembers: vi.fn().mockResolvedValue([]),
}));
vi.mock('../agent-bridge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agent-bridge.js')>();
  return { ...original, queryAgent: vi.fn() };
});

import { SessionStore } from '../session-store.js';
import { SessionRouter } from '../session-router.js';
import { GroupContext } from '../group-context.js';
import { StreamRelay } from '../stream-relay.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import { queryAgent } from '../agent-bridge.js';
import { handleMessage } from '../index.js';
import { CronStore } from '../cron-store.js';
import { synthesizeCronMessage } from '../cron-scheduler.js';
import type { CronTask } from '../cron-store.js';
import type { Config } from '../config.js';
import { ChannelType } from '../octo/types.js';
import { sendMessage } from '../octo/api.js';

const BOT_ID = 'bot-001';
const OWNER = 'owner-uid';

let dir: string;
let adapter: DbAdapter;
let store: SessionStore;
let router: SessionRouter;
let groupContext: GroupContext;
let streamRelay: StreamRelay;
let cronStore: CronStore;
let config: Config;

function makeConfig(): Config {
  return {
    botToken: 't', apiUrl: 'https://t.example.com',
    baseDir: dir, botId: 'default', cwd: join(dir, 'ws'), cwdBase: join(dir, 'ws'),
    dataDir: join(dir, 'data'), memoryBase: join(dir, 'mem'),
    sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], cron: true },
    rateLimit: { maxPerMinute: 60 }, context: { maxContextChars: 6000, historyLimit: 40 },
  };
}
function mockReply(text: string): void {
  (queryAgent as ReturnType<typeof vi.fn>).mockImplementation(async function* () { yield text; });
}
function task(over: Partial<CronTask> = {}): CronTask {
  return {
    id: 't1', schedule: '* * * * *', recurring: true, prompt: 'run the daily report',
    channelId: 'grp-1', channelType: ChannelType.Group, fromUid: OWNER, fromName: 'Owner',
    createdBy: OWNER, enabled: true, createdAt: 1, lastRun: null, nextRun: Date.now() - 1000, ...over,
  };
}

describe('cron integration (#115)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'cc-cron-int-'));
    config = makeConfig();
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter); store.init();
    router = new SessionRouter(config, BOT_ID, OWNER);
    groupContext = new GroupContext(adapter, 6000);
    streamRelay = new StreamRelay();
    cronStore = new CronStore(join(dir, 'cron.json'));
    mockReply('done');
  });
  afterEach(() => { adapter.close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('a cron-fired GROUP message reaches the agent (mention gate bypassed) and replies to the channel', async () => {
    const msg = synthesizeCronMessage(task({ channelId: 'grp-1', channelType: ChannelType.Group }));
    await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID, cronStore);

    expect(queryAgent).toHaveBeenCalledTimes(1);
    const userMsg = (queryAgent as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(userMsg).toContain('run the daily report');

    // reply went back to the bound channel
    expect(sendMessage).toHaveBeenCalled();
    const sentTo = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].channelId;
    expect(sentTo).toBe('grp-1');
  });

  it('a cron-fired DM message reaches the agent', async () => {
    const msg = synthesizeCronMessage(task({ channelId: '', channelType: ChannelType.DM, fromUid: 'peer-9' }));
    await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID, cronStore);
    expect(queryAgent).toHaveBeenCalledTimes(1);
  });

  it('a cron fire (message_seq=0) does NOT poison the reply-seq cursor (#3)', async () => {
    const msg = synthesizeCronMessage(task({ channelId: '', channelType: ChannelType.DM, fromUid: 'peer-9' }));
    expect(msg.message_seq).toBe(0);
    await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID, cronStore);
    // sessionKey for this DM is from_uid; the cursor must stay unset (not 0).
    expect(store.getLastBotReplySeq('peer-9')).toBeUndefined();
  });

  it('the agent turn is offered the cron MCP tool (mcpServers.cron present)', async () => {
    let captured: Record<string, unknown> | undefined;
    (queryAgent as ReturnType<typeof vi.fn>).mockImplementation(
      async function* (_u: string, _h: string, _c: string, _cfg: unknown, _ctx: unknown, _t: unknown, opts: { mcpServers?: Record<string, unknown> }) {
        captured = opts?.mcpServers;
        yield 'ok';
      },
    );
    const msg = synthesizeCronMessage(task());
    await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID, cronStore);
    expect(captured).toBeDefined();
    expect(captured!.cron).toBeDefined();
  });

  it('a FAILED cron fire is attributed to its task at the real catch site (#A)', async () => {
    // The production failure path: queryAgent throws → handleMessage's own
    // try/catch swallows it (sends a user-facing error reply, never rethrows).
    // The cron attribution must therefore happen INSIDE that catch, keyed off
    // the synthetic `cron:<taskId>:<ts>` message_id — not on a returned promise
    // (handleMessage always resolves). Regression guard for PR #118.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (queryAgent as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
      throw new Error('agent blew up');
      yield ''; // unreachable; keeps the generator well-typed
    });
    const msg = synthesizeCronMessage(task({ id: 'doomed', channelId: '', channelType: ChannelType.DM, fromUid: 'peer-9' }));
    await handleMessage(msg, config, store, router, groupContext, streamRelay, BOT_ID, cronStore);

    const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/doomed/);
    expect(logged).toMatch(/failed during execution/);
    errSpy.mockRestore();
  });
});

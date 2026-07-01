/**
 * P3-2: THREAD.md write-back tool tests (group-md-tool.ts, update_thread_md).
 *
 * Drives the tool handler directly via buildThreadMdTools (the MCP server keeps
 * tools private). The SDK's `tool`/`createSdkMcpServer` are mocked to plain
 * passthroughs so the module loads without the real SDK.
 *
 * Covers the acceptance gates at the policy layer:
 *   - owner-gate: only the bot owner may write (non-owner / empty-owner rejected,
 *     no server call);
 *   - the write targets the thread's OWN md path (groupNo + shortId), NEVER the
 *     parent group — this is the XIN-230 follow-up the ticket exists to fix;
 *   - a non-thread channelId is refused (thread tool is thread-only);
 *   - ≤10240-byte UTF-8 rejection surfaces a clean error (no server call);
 *   - concurrent tool calls for the same thread serialize through the shared
 *     coordinator (no overlap, no lost write).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

import {
  buildThreadMdTools,
  createThreadMdToolServer,
  THREAD_MD_TOOL_SERVER_NAME,
  type GroupMdSessionCoords,
  type ThreadMdToolDeps,
} from '../group-md-tool.js';
import { ThreadMdWriteback, MAX_THREAD_MD_CONTENT_BYTES, type UpdateThreadMdFn } from '../group-md-writeback.js';
import { ThreadMdCache } from '../group-md-cache.js';

const OWNER = 'owner-uid';
const API = 'https://api.example.com';
const TOKEN = 'bot-token';
const GROUP = 'grp-7';
const SHORT = 'thread9';
const THREAD_CHAN = `${GROUP}____${SHORT}`;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function coords(over: Partial<GroupMdSessionCoords> = {}): GroupMdSessionCoords {
  return { channelId: THREAD_CHAN, fromUid: OWNER, fromName: 'Owner', ...over };
}

function getTool(deps: ThreadMdToolDeps, c: GroupMdSessionCoords, owner = OWNER) {
  const t = buildThreadMdTools(deps, c, owner).find((x) => x.name === 'update_thread_md');
  if (!t) throw new Error('tool update_thread_md not found');
  return t as { name: string; handler: (args: { content: string }, extra: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };
}
function text(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('thread-md-tool', () => {
  let cache: ThreadMdCache;
  let putFn: ReturnType<typeof vi.fn<UpdateThreadMdFn>>;
  let deps: ThreadMdToolDeps;

  beforeEach(() => {
    cache = new ThreadMdCache();
    let version = 0;
    putFn = vi.fn<UpdateThreadMdFn>(async () => ({ version: ++version }));
    deps = { writeback: new ThreadMdWriteback(cache, putFn), apiUrl: API, botToken: TOKEN };
  });

  it('createThreadMdToolServer builds an MCP server named "thread_md"', () => {
    const s = createThreadMdToolServer(deps, coords(), OWNER);
    expect(THREAD_MD_TOOL_SERVER_NAME).toBe('thread_md');
    expect((s as { name: string }).name).toBe('thread_md');
  });

  it('owner write: PUTs to the thread (groupNo + shortId), NOT the parent group, and refreshes the cache', async () => {
    const r = await getTool(deps, coords()).handler({ content: 'thread persona' }, {});
    expect(r.isError).toBeFalsy();
    expect(putFn).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, botToken: TOKEN, groupNo: GROUP, shortId: SHORT, content: 'thread persona' }),
    );
    expect(text(r)).toContain('"version": 1');
    expect(text(r)).toContain(`"shortId": "${SHORT}"`);
    expect(cache.get(GROUP, SHORT)).toEqual({ content: 'thread persona', version: 1, updated_at: null });
  });

  it('non-owner write is rejected and never calls the server', async () => {
    const r = await getTool(deps, coords({ fromUid: 'rando' })).handler({ content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/only the bot owner/i);
    expect(putFn).not.toHaveBeenCalled();
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('empty owner uid gates everyone out (no owner → unusable)', async () => {
    const r = await getTool(deps, coords(), '').handler({ content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(putFn).not.toHaveBeenCalled();
  });

  it('a plain (non-thread) channelId is refused — the thread tool is thread-only', async () => {
    const r = await getTool(deps, coords({ channelId: 'plain-group' })).handler({ content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not a thread/i);
    expect(putFn).not.toHaveBeenCalled();
  });

  it('over-limit content is rejected with a clear error and no server call', async () => {
    const tooBig = 'a'.repeat(MAX_THREAD_MD_CONTENT_BYTES + 1);
    const r = await getTool(deps, coords()).handler({ content: tooBig }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/over the 10240-byte/i);
    expect(putFn).not.toHaveBeenCalled();
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('content exactly at the limit is accepted', async () => {
    const atLimit = 'a'.repeat(MAX_THREAD_MD_CONTENT_BYTES);
    const r = await getTool(deps, coords()).handler({ content: atLimit }, {});
    expect(r.isError).toBeFalsy();
    expect(putFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the client error when the PUT fails (cache untouched)', async () => {
    putFn.mockRejectedValueOnce(new Error('Octo API PUT failed (403): forbidden'));
    const r = await getTool(deps, coords()).handler({ content: 'doc' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/PUT failed/);
    expect(cache.get(GROUP, SHORT)).toBeUndefined();
  });

  it('serializes concurrent tool calls for the same thread through the shared coordinator', async () => {
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const order: string[] = [];
    const slow: UpdateThreadMdFn = async (p) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(p.content);
      active--;
      return { version: ++version };
    };
    const shared = new ThreadMdWriteback(cache, slow);
    const d: ThreadMdToolDeps = { writeback: shared, apiUrl: API, botToken: TOKEN };

    const tA = getTool(d, coords());
    const tB = getTool(d, coords());
    const results = await Promise.all([
      tA.handler({ content: 'A' }, {}),
      tB.handler({ content: 'B' }, {}),
    ]);

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(2);
    expect(cache.get(GROUP, SHORT)?.version).toBe(2);
  });
});

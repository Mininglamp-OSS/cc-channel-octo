/**
 * P2-C: GROUP.md write-back tool tests (group-md-tool.ts).
 *
 * Drives the tool handler directly via buildGroupMdTools (the MCP server keeps
 * tools private). The SDK's `tool`/`createSdkMcpServer` are mocked to plain
 * passthroughs so the module loads without the real SDK.
 *
 * Covers the acceptance gates at the policy layer:
 *   - owner-gate: only the bot owner may write (non-owner / empty-owner rejected,
 *     no server call);
 *   - ≤10240-byte UTF-8 rejection surfaces a clean error (no server call);
 *   - a successful write hits A's updateGroupMd client and refreshes the cache;
 *   - a thread channelId resolves to its PARENT group number;
 *   - concurrent tool calls for the same group serialize through the shared
 *     coordinator (no overlap, no lost write).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

import {
  buildGroupMdTools,
  createGroupMdToolServer,
  GROUP_MD_TOOL_SERVER_NAME,
  type GroupMdSessionCoords,
  type GroupMdToolDeps,
} from '../group-md-tool.js';
import { GroupMdWriteback, MAX_GROUP_MD_CONTENT_BYTES, type UpdateGroupMdFn } from '../group-md-writeback.js';
import { GroupMdCache } from '../group-md-cache.js';

const OWNER = 'owner-uid';
const API = 'https://api.example.com';
const TOKEN = 'bot-token';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function coords(over: Partial<GroupMdSessionCoords> = {}): GroupMdSessionCoords {
  return { channelId: 'grp-1', fromUid: OWNER, fromName: 'Owner', ...over };
}

function getTool(deps: GroupMdToolDeps, c: GroupMdSessionCoords, owner = OWNER) {
  const t = buildGroupMdTools(deps, c, owner).find((x) => x.name === 'update_group_md');
  if (!t) throw new Error('tool update_group_md not found');
  return t as { name: string; handler: (args: { content: string }, extra: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };
}
function text(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('group-md-tool', () => {
  let cache: GroupMdCache;
  let putFn: ReturnType<typeof vi.fn<UpdateGroupMdFn>>;
  let deps: GroupMdToolDeps;

  beforeEach(() => {
    cache = new GroupMdCache();
    let version = 0;
    putFn = vi.fn<UpdateGroupMdFn>(async () => ({ version: ++version }));
    deps = { writeback: new GroupMdWriteback(cache, putFn), apiUrl: API, botToken: TOKEN };
  });

  it('createGroupMdToolServer builds an MCP server named "group_md"', () => {
    const s = createGroupMdToolServer(deps, coords(), OWNER);
    expect(GROUP_MD_TOOL_SERVER_NAME).toBe('group_md');
    expect((s as { name: string }).name).toBe('group_md');
  });

  it('owner write: PUTs the content and refreshes the cache', async () => {
    const r = await getTool(deps, coords()).handler({ content: 'new persona' }, {});
    expect(r.isError).toBeFalsy();
    expect(putFn).toHaveBeenCalledWith(
      expect.objectContaining({ apiUrl: API, botToken: TOKEN, groupNo: 'grp-1', content: 'new persona' }),
    );
    expect(text(r)).toContain('"version": 1');
    expect(cache.get('grp-1')).toEqual({ content: 'new persona', version: 1, updated_at: null });
  });

  it('non-owner write is rejected and never calls the server', async () => {
    const r = await getTool(deps, coords({ fromUid: 'rando' })).handler({ content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/only the bot owner/i);
    expect(putFn).not.toHaveBeenCalled();
    expect(cache.get('grp-1')).toBeUndefined();
  });

  it('empty owner uid gates everyone out (no owner → unusable)', async () => {
    const r = await getTool(deps, coords(), '').handler({ content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(putFn).not.toHaveBeenCalled();
  });

  it('over-limit content is rejected with a clear error and no server call', async () => {
    const tooBig = 'a'.repeat(MAX_GROUP_MD_CONTENT_BYTES + 1);
    const r = await getTool(deps, coords()).handler({ content: tooBig }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/over the 10240-byte/i);
    expect(putFn).not.toHaveBeenCalled();
    expect(cache.get('grp-1')).toBeUndefined();
  });

  it('content exactly at the limit is accepted', async () => {
    const atLimit = 'a'.repeat(MAX_GROUP_MD_CONTENT_BYTES);
    const r = await getTool(deps, coords()).handler({ content: atLimit }, {});
    expect(r.isError).toBeFalsy();
    expect(putFn).toHaveBeenCalledTimes(1);
  });

  it('a thread channelId writes to its PARENT group number', async () => {
    const r = await getTool(deps, coords({ channelId: 'grp-7____thread9' })).handler({ content: 'doc' }, {});
    expect(r.isError).toBeFalsy();
    expect(putFn).toHaveBeenCalledWith(expect.objectContaining({ groupNo: 'grp-7' }));
    expect(cache.get('grp-7')).toMatchObject({ content: 'doc' });
  });

  it('surfaces the client error when the PUT fails (cache untouched)', async () => {
    putFn.mockRejectedValueOnce(new Error('Octo API PUT failed (400): err.server.bot_api.content_too_large'));
    const r = await getTool(deps, coords()).handler({ content: 'doc' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/PUT failed/);
    expect(cache.get('grp-1')).toBeUndefined();
  });

  it('serializes concurrent tool calls for the same group through the shared coordinator', async () => {
    let active = 0;
    let maxActive = 0;
    let version = 0;
    const order: string[] = [];
    const slow: UpdateGroupMdFn = async (p) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(10);
      order.push(p.content);
      active--;
      return { version: ++version };
    };
    const shared = new GroupMdWriteback(cache, slow);
    const d: GroupMdToolDeps = { writeback: shared, apiUrl: API, botToken: TOKEN };

    // Two separate per-turn tool instances (as in production) borrowing the same
    // shared coordinator — concurrency must still be contained.
    const tA = getTool(d, coords());
    const tB = getTool(d, coords());
    const results = await Promise.all([
      tA.handler({ content: 'A' }, {}),
      tB.handler({ content: 'B' }, {}),
    ]);

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(2); // both writes executed; none lost
    expect(cache.get('grp-1')?.version).toBe(2);
  });
});

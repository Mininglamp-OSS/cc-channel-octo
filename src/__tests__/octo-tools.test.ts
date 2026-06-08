/**
 * octo-tools (#87) read-only agent tool tests.
 *
 * Drives each tool's handler directly (the MCP server keeps tools in private
 * internals, so we test via buildOctoTools). octo/api.js is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config.js';

vi.mock('../octo/api.js', () => ({
  fetchBotGroups: vi.fn(),
  getGroupInfo: vi.fn(),
  getGroupMembers: vi.fn(),
  searchSpaceMembers: vi.fn(),
}));

import { buildOctoTools, createOctoToolServer, OCTO_TOOL_SERVER_NAME } from '../octo-tools.js';
import { fetchBotGroups, getGroupInfo, getGroupMembers, searchSpaceMembers } from '../octo/api.js';

function cfg(): Config {
  return {
    botToken: 'bf_tok',
    apiUrl: 'https://api.example.com',
    baseDir: '/base',
    cwd: '/base/default/workspace',
    cwdBase: '/base/default/workspace',
    dataDir: '/base/default/data',
    sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [] },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524_288,
  };
}

/** Find a tool definition by name. */
function getTool(name: string) {
  const t = buildOctoTools(cfg()).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

/** Extract the text content of a tool result. */
function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('octo-tools: read-only server', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes exactly the four read-only tools', () => {
    const names = buildOctoTools(cfg()).map((t) => t.name).sort();
    expect(names).toEqual(['group_info', 'group_members', 'list_groups', 'search_members']);
  });

  it('createOctoToolServer builds an MCP server named "octo"', () => {
    const server = createOctoToolServer(cfg());
    expect(OCTO_TOOL_SERVER_NAME).toBe('octo');
    expect((server as { name: string }).name).toBe('octo');
  });

  it('list_groups calls fetchBotGroups with apiUrl/botToken and returns JSON', async () => {
    vi.mocked(fetchBotGroups).mockResolvedValue([{ groupNo: 'g1', name: 'Group One' }] as never);
    const r = await getTool('list_groups').handler({}, {});
    expect(fetchBotGroups).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com', botToken: 'bf_tok' });
    expect(text(r)).toContain('Group One');
  });

  it('group_info passes the groupNo through', async () => {
    vi.mocked(getGroupInfo).mockResolvedValue({ groupNo: 'g7', name: 'Seven' } as never);
    const r = await getTool('group_info').handler({ groupNo: 'g7' }, {});
    expect(getGroupInfo).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com', botToken: 'bf_tok', groupNo: 'g7' });
    expect(text(r)).toContain('Seven');
  });

  it('group_members passes the groupNo through', async () => {
    vi.mocked(getGroupMembers).mockResolvedValue([{ uid: 'u1', name: 'Alice' }] as never);
    const r = await getTool('group_members').handler({ groupNo: 'g9' }, {});
    expect(getGroupMembers).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com', botToken: 'bf_tok', groupNo: 'g9' });
    expect(text(r)).toContain('Alice');
  });

  it('search_members forwards keyword + optional limit', async () => {
    vi.mocked(searchSpaceMembers).mockResolvedValue([{ uid: 'u2', name: 'Bob' }] as never);
    await getTool('search_members').handler({ keyword: 'Bo', limit: 10 }, {});
    expect(searchSpaceMembers).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com', botToken: 'bf_tok', keyword: 'Bo', limit: 10 });
  });

  it('omits limit when not provided', async () => {
    vi.mocked(searchSpaceMembers).mockResolvedValue([] as never);
    await getTool('search_members').handler({ keyword: 'x' }, {});
    expect(searchSpaceMembers).toHaveBeenCalledWith({ apiUrl: 'https://api.example.com', botToken: 'bf_tok', keyword: 'x' });
  });

  it('returns an isError result (no throw) when the API call fails', async () => {
    vi.mocked(fetchBotGroups).mockRejectedValue(new Error('boom'));
    const r = await getTool('list_groups').handler({}, {}) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('boom');
  });
});

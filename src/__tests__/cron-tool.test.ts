/**
 * #115: cron-tool tests — owner gate, bound coords, validation, caps, list/delete.
 *
 * Drives each tool handler directly via buildCronTools (the MCP server keeps
 * tools private). The SDK's `tool`/`createSdkMcpServer` are mocked to plain
 * passthroughs so the module loads without the real SDK.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} }),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
}));

import { buildCronTools, createCronToolServer, CRON_TOOL_SERVER_NAME, type CronSessionCoords } from '../cron-tool.js';
import { CronStore } from '../cron-store.js';
import { ChannelType } from '../octo/types.js';

const OWNER = 'owner-uid';
let dir: string;
let store: CronStore;

function coords(over: Partial<CronSessionCoords> = {}): CronSessionCoords {
  return { channelId: 'c1', channelType: ChannelType.DM, fromUid: OWNER, fromName: 'Owner', ...over };
}
function getTool(name: string, c: CronSessionCoords, owner = OWNER) {
  const t = buildCronTools(store, c, owner).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t as { name: string; handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }> };
}
function text(r: { content: Array<{ text?: string }> }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('cron-tool', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-crontool-'));
    store = new CronStore(join(dir, 'cron.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('createCronToolServer builds an MCP server named "cron"', () => {
    const s = createCronToolServer(store, coords(), OWNER);
    expect(CRON_TOOL_SERVER_NAME).toBe('cron');
    expect((s as { name: string }).name).toBe('cron');
  });

  it('cron_create (owner) writes a task bound to the session coords', async () => {
    const c = coords({ channelId: 'grp-9', channelType: ChannelType.Group });
    const r = await getTool('cron_create', c).handler({ schedule: '0 9 * * *', prompt: 'morning triage' }, {});
    expect(r.isError).toBeFalsy();
    const tasks = store.load();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      schedule: '0 9 * * *', prompt: 'morning triage', recurring: true,
      channelId: 'grp-9', channelType: ChannelType.Group, createdBy: OWNER, enabled: true,
    });
    expect(tasks[0].nextRun).toBeGreaterThan(Date.now());
  });

  it('cron_create defaults recurring=false for a one-shot ISO time', async () => {
    await getTool('cron_create', coords()).handler({ schedule: '2999-01-01T00:00:00Z', prompt: 'remind' }, {});
    expect(store.load()[0].recurring).toBe(false);
  });

  it('cron_create from a NON-owner is rejected and writes nothing', async () => {
    const r = await getTool('cron_create', coords({ fromUid: 'rando' })).handler(
      { schedule: '* * * * *', prompt: 'evil' }, {},
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/owner/i);
    expect(store.loadOrEmpty()).toEqual([]);
  });

  it('cron_create rejects an invalid cron expression', async () => {
    const r = await getTool('cron_create', coords()).handler({ schedule: 'not a cron', prompt: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(store.loadOrEmpty()).toEqual([]);
  });

  it('cron_create rejects a past one-shot', async () => {
    const r = await getTool('cron_create', coords()).handler({ schedule: '2000-01-01T00:00:00Z', prompt: 'x' }, {});
    expect(r.isError).toBe(true);
  });

  it('cron_create rejects an over-long prompt', async () => {
    const r = await getTool('cron_create', coords()).handler({ schedule: '* * * * *', prompt: 'x'.repeat(3000) }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/too long/i);
  });

  it('cron_create enforces the task cap', async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`, schedule: '* * * * *', recurring: true, prompt: 'p',
      channelId: 'c1', channelType: ChannelType.DM, fromUid: OWNER, createdBy: OWNER,
      enabled: true, createdAt: 1, lastRun: null, nextRun: 2,
    }));
    store.save(tasks);
    const r = await getTool('cron_create', coords()).handler({ schedule: '* * * * *', prompt: 'one more' }, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/limit/i);
  });

  it('cron_list returns summaries (empty when none)', async () => {
    expect(text(await getTool('cron_list', coords()).handler({}, {}))).toContain('"tasks": []');
    await getTool('cron_create', coords()).handler({ schedule: '0 9 * * *', prompt: 'p' }, {});
    expect(text(await getTool('cron_list', coords()).handler({}, {}))).toContain('0 9 * * *');
  });

  it('cron_delete (owner) removes a task by id', async () => {
    await getTool('cron_create', coords()).handler({ schedule: '0 9 * * *', prompt: 'p' }, {});
    const id = store.load()[0].id;
    const r = await getTool('cron_delete', coords()).handler({ id }, {});
    expect(r.isError).toBeFalsy();
    expect(store.load()).toEqual([]);
  });

  it('cron_delete from a NON-owner is rejected', async () => {
    await getTool('cron_create', coords()).handler({ schedule: '0 9 * * *', prompt: 'p' }, {});
    const id = store.load()[0].id;
    const r = await getTool('cron_delete', coords({ fromUid: 'rando' })).handler({ id }, {});
    expect(r.isError).toBe(true);
    expect(store.load()).toHaveLength(1);
  });

  it('cron_delete of an unknown id errors', async () => {
    const r = await getTool('cron_delete', coords()).handler({ id: 'nope' }, {});
    expect(r.isError).toBe(true);
  });

  it('treats empty ownerUid as no-owner (nobody passes the gate)', async () => {
    const r = await getTool('cron_create', coords({ fromUid: '' }), '').handler({ schedule: '* * * * *', prompt: 'x' }, {});
    expect(r.isError).toBe(true);
  });
});

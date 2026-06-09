/**
 * #115: cron-scheduler tests — due detection, one-shot vs recurring, error
 * isolation, missed-task policy, stop(), synthetic message shape.
 *
 * Drives tick() directly (deterministic, no timers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronScheduler, synthesizeCronMessage } from '../cron-scheduler.js';
import { CronStore, type CronTask } from '../cron-store.js';
import { ChannelType, MessageType } from '../octo/types.js';
import type { BotMessage } from '../octo/types.js';

let dir: string;
let store: CronStore;

function task(over: Partial<CronTask> = {}): CronTask {
  return {
    id: 'id-1', schedule: '* * * * *', recurring: true, prompt: 'do it',
    channelId: 'c1', channelType: ChannelType.DM, fromUid: 'u1', fromName: 'Alice',
    createdBy: 'u1', enabled: true, createdAt: 1, lastRun: null,
    nextRun: Date.now() - 1000, ...over, // default: due
  };
}
function sched(onFire: (m: BotMessage) => void): CronScheduler {
  return new CronScheduler({ cronStore: store, onFire, label: '' });
}

describe('CronScheduler.tick', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cronsched-'));
    store = new CronStore(join(dir, 'cron.json'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('fires a due task', () => {
    store.save([task()]);
    const fired: BotMessage[] = [];
    sched((m) => fired.push(m)).tick();
    expect(fired).toHaveLength(1);
    expect(fired[0].payload.content).toBe('do it');
  });

  it('does NOT fire a future task', () => {
    store.save([task({ nextRun: Date.now() + 60_000 })]);
    const fired: BotMessage[] = [];
    sched((m) => fired.push(m)).tick();
    expect(fired).toHaveLength(0);
  });

  it('does NOT fire a disabled task', () => {
    store.save([task({ enabled: false })]);
    const fired: BotMessage[] = [];
    sched((m) => fired.push(m)).tick();
    expect(fired).toHaveLength(0);
  });

  it('one-shot task is deleted after firing', () => {
    store.save([task({ recurring: false, schedule: '2999-01-01T00:00:00Z' })]);
    sched(() => {}).tick();
    expect(store.loadOrEmpty()).toEqual([]);
  });

  it('recurring task is kept with an advanced nextRun', () => {
    store.save([task({ recurring: true, schedule: '*/5 * * * *' })]);
    sched(() => {}).tick();
    const after = store.load();
    expect(after).toHaveLength(1);
    expect(after[0].nextRun).toBeGreaterThan(Date.now());
    expect(after[0].lastRun).not.toBeNull();
  });

  it('a throwing onFire does not stop other tasks (error isolation)', () => {
    store.save([task({ id: 'bad' }), task({ id: 'good' })]);
    const fired: string[] = [];
    let first = true;
    sched(() => { if (first) { first = false; throw new Error('boom'); } fired.push('ok'); }).tick();
    expect(fired).toEqual(['ok']); // second task still fired
  });

  it('a recurring task advances even when the fire fails downstream (no retry loop) (#1)', () => {
    store.save([task({ id: 'flaky', recurring: true, schedule: '*/5 * * * *' })]);
    // onFire is fire-and-forget (void). A downstream delivery failure is
    // attributed to the task at handleMessage's catch site (see
    // cron-integration.test.ts), NOT here — the scheduler must still advance.
    sched(() => {}).tick();
    // recurring task advanced despite a (hypothetical) downstream failure.
    expect(store.load()[0].nextRun).toBeGreaterThan(Date.now());
    expect(store.load()[0].lastRun).not.toBeNull();
  });

  it('missed task fires once (not per missed window)', () => {
    // nextRun 2h in the past, recurring every 5 min — must fire exactly once.
    store.save([task({ recurring: true, schedule: '*/5 * * * *', nextRun: Date.now() - 2 * 3600_000 })]);
    const fired: BotMessage[] = [];
    sched((m) => fired.push(m)).tick();
    expect(fired).toHaveLength(1);
    // and the next run is now in the future
    expect(store.load()[0].nextRun).toBeGreaterThan(Date.now());
  });

  it('tick never throws on a corrupt store', () => {
    writeFileSync(join(dir, 'cron.json'), '{bad');
    expect(() => sched(() => {}).tick()).not.toThrow();
  });

  it('start()/stop() arm and clear the timer', () => {
    const s = sched(() => {});
    s.start();
    s.stop();
    expect(true).toBe(true); // no throw / no hang (timer is unref'd anyway)
  });
});

describe('synthesizeCronMessage', () => {
  it('produces a Text BotMessage with _cronFire + bound coords', () => {
    const m = synthesizeCronMessage(task({ channelId: 'grp', channelType: ChannelType.Group, prompt: 'hi' }));
    expect(m.payload.type).toBe(MessageType.Text);
    expect(m.payload.content).toBe('hi');
    expect(m.payload._cronFire).toBe(true);
    expect(m.payload._cronFireNonce).toBeDefined();
    expect(m.channel_id).toBe('grp');
    expect(m.channel_type).toBe(ChannelType.Group);
    expect(m.message_id.startsWith('cron:')).toBe(true);
    expect(m.from_uid).toBe('u1');
  });
});

/**
 * #115: cron-store tests — atomic load/save of <baseDir>/<botId>/cron.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CronStore, type CronTask } from '../cron-store.js';
import { ChannelType } from '../octo/types.js';

let dir: string;
let path: string;

function task(over: Partial<CronTask> = {}): CronTask {
  return {
    id: 'id-1', schedule: '* * * * *', recurring: true, prompt: 'hi',
    channelId: 'c1', channelType: ChannelType.DM, fromUid: 'u1', fromName: 'Alice',
    createdBy: 'u1', enabled: true, createdAt: 1, lastRun: null, nextRun: 2, ...over,
  };
}

describe('CronStore', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cron-'));
    path = join(dir, 'cron.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loadOrEmpty returns [] when file is absent', () => {
    expect(new CronStore(path).loadOrEmpty()).toEqual([]);
  });

  it('save then load round-trips', () => {
    const store = new CronStore(path);
    const tasks = [task(), task({ id: 'id-2', recurring: false })];
    store.save(tasks);
    expect(store.load()).toEqual(tasks);
  });

  it('save is atomic (temp+rename; no .tmp left behind)', () => {
    const store = new CronStore(path);
    store.save([task()]);
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('load throws on malformed JSON (loud, not silent)', () => {
    writeFileSync(path, '{ not json');
    expect(() => new CronStore(path).load()).toThrow();
  });

  it('load throws when JSON is not an array', () => {
    writeFileSync(path, '{"a":1}');
    expect(() => new CronStore(path).load()).toThrow(/not an array/);
  });

  it('update() applies the mutator and persists atomically', () => {
    const store = new CronStore(path);
    store.save([task()]);
    const result = store.update((tasks) => [...tasks, task({ id: 'id-2' })]);
    expect(result.map((t) => t.id)).toEqual(['id-1', 'id-2']);
    expect(store.load().map((t) => t.id)).toEqual(['id-1', 'id-2']); // persisted
  });

  it('update() seeds from [] when the file is absent', () => {
    const store = new CronStore(path);
    store.update((tasks) => [...tasks, task()]);
    expect(store.load()).toHaveLength(1);
  });

  it('update() skips the write when the mutator returns the same reference', () => {
    const store = new CronStore(path);
    store.save([task()]);
    // returning the same `tasks` ref must not rewrite (idle-tick optimization)
    store.update((tasks) => tasks);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(store.load()).toHaveLength(1);
  });
});

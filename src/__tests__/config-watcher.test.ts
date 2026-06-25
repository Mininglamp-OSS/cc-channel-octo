import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile, watchConfig, type Reconcilable } from '../config-watcher.js';

// ─── A fake manager recording add/remove + tracking the running set ──────────

function fakeManager(initial: string[] = []): Reconcilable & {
  added: string[];
  removed: string[];
} {
  const running = new Set(initial);
  const added: string[] = [];
  const removed: string[] = [];
  return {
    added,
    removed,
    runningKeys: () => [...running],
    addBot: async (id: string) => {
      added.push(id);
      running.add(id);
    },
    removeBot: async (id: string) => {
      removed.push(id);
      running.delete(id);
    },
  };
}

// ─── reconcile ───────────────────────────────────────────────────────────────

describe('#157 reconcile', () => {
  it('adds missing and removes extra to match desired', async () => {
    const mgr = fakeManager(['a', 'b']);
    await reconcile(mgr, ['b', 'c']);
    expect(mgr.removed).toEqual(['a']);
    expect(mgr.added).toEqual(['c']);
    expect(mgr.runningKeys().sort()).toEqual(['b', 'c']);
  });

  it('removes before adds (free a resource before its replacement claims it)', async () => {
    const order: string[] = [];
    const mgr: Reconcilable = {
      runningKeys: () => ['old'],
      addBot: async (id) => { order.push(`add:${id}`); },
      removeBot: async (id) => { order.push(`rm:${id}`); },
    };
    await reconcile(mgr, ['new']);
    expect(order).toEqual(['rm:old', 'add:new']);
  });

  it('swallows a single addBot failure and continues with the rest', async () => {
    const order: string[] = [];
    const mgr: Reconcilable = {
      runningKeys: () => [],
      addBot: async (id) => {
        order.push(id);
        if (id === 'bad') throw new Error('boom');
      },
      removeBot: async () => {},
    };
    await reconcile(mgr, ['good1', 'bad', 'good2']);
    expect(order).toEqual(['good1', 'bad', 'good2']); // all attempted
  });

  it('no-op when desired equals running', async () => {
    const mgr = fakeManager(['a', 'b']);
    await reconcile(mgr, ['a', 'b']);
    expect(mgr.added).toEqual([]);
    expect(mgr.removed).toEqual([]);
  });

  it('stops mid-reconcile when superseded by a newer generation (isStale)', async () => {
    const mgr = fakeManager([]);
    // desired wants a, b, c — but a newer config arrives right after the first add
    let stale = false;
    const order: string[] = [];
    const wrapped: Reconcilable = {
      runningKeys: () => mgr.runningKeys(),
      addBot: async (id) => {
        order.push(id);
        await mgr.addBot(id);
        if (id === 'a') stale = true; // a newer event lands after the first add
      },
      removeBot: mgr.removeBot,
    };
    await reconcile(wrapped, ['a', 'b', 'c'], () => {}, () => stale);
    // Only 'a' applied; 'b'/'c' abandoned because the reconcile was superseded.
    expect(order).toEqual(['a']);
  });
});

// ─── watchConfig (real tmp dir + atomic rename) ──────────────────────────────

describe('#157 watchConfig', () => {
  function tmpConfig(): { dir: string; path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'cc-watch-'));
    const path = join(dir, 'config.json');
    return { dir, path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** Atomic write (temp + rename) mirroring the daemon's write strategy. */
  function atomicWrite(path: string, ids: string[]): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ bots: ids.map((id) => ({ id })) }));
    renameSync(tmp, path);
  }

  it('applyNow reconciles to the on-disk desired set', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      atomicWrite(path, ['a', 'b']);
      const mgr = fakeManager([]);
      const h = watchConfig({
        configPath: path,
        manager: mgr,
        loadDesired: () => ['a', 'b'],
        debounceMs: 10,
      });
      await h.applyNow();
      expect(mgr.added.sort()).toEqual(['a', 'b']);
      h.close();
    } finally {
      cleanup();
    }
  });

  it('keeps current bots when loadDesired throws (invalid/half-written config)', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      atomicWrite(path, ['a']);
      const mgr = fakeManager(['a']);
      const h = watchConfig({
        configPath: path,
        manager: mgr,
        loadDesired: () => {
          throw new Error('half-written / invalid');
        },
        debounceMs: 10,
      });
      await h.applyNow();
      // current set untouched
      expect(mgr.added).toEqual([]);
      expect(mgr.removed).toEqual([]);
      h.close();
    } finally {
      cleanup();
    }
  });

  it('fires a reconcile on a file change (debounced)', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      atomicWrite(path, ['a']);
      let desired = ['a'];
      const mgr = fakeManager(['a']);
      const logs: string[] = [];
      const h = watchConfig({
        configPath: path,
        manager: mgr,
        loadDesired: () => desired,
        debounceMs: 20,
        log: (m) => logs.push(m),
      });
      // change desired and rewrite the file → watcher should pick it up on its
      // own (no manual applyNow, so the assertion proves the fs.watch path fired)
      desired = ['a', 'b'];
      atomicWrite(path, ['a', 'b']);
      // poll up to ~2s for the debounced watcher-driven reconcile to add 'b'
      for (let i = 0; i < 40 && !mgr.added.includes('b'); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(mgr.added).toContain('b');
      expect(logs.some((m) => m.includes('added bot b'))).toBe(true);
      h.close();
    } finally {
      cleanup();
    }
  });

  it('close() stops further apply', async () => {
    const { path, cleanup } = tmpConfig();
    try {
      atomicWrite(path, ['a']);
      const mgr = fakeManager([]);
      const loadDesired = vi.fn(() => ['a']);
      const h = watchConfig({ configPath: path, manager: mgr, loadDesired, debounceMs: 10 });
      h.close();
      await h.applyNow();
      // applyNow after close is a no-op (guard inside the task)
      expect(mgr.added).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

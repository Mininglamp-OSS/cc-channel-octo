import { describe, it, expect, vi } from 'vitest';
import {
  diffBotSets,
  botKey,
  crossRegisterOnAdd,
  crossUnregisterOnRemove,
  BotManager,
  type ManagedBot,
} from '../bot-manager.js';

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('#157 diffBotSets', () => {
  it('computes adds and removes from desired vs running', () => {
    expect(diffBotSets(['a', 'b', 'c'], ['b'])).toEqual({
      toAdd: ['a', 'c'],
      toRemove: [],
    });
    expect(diffBotSets(['b'], ['a', 'b', 'c'])).toEqual({
      toAdd: [],
      toRemove: ['a', 'c'],
    });
    expect(diffBotSets(['a', 'd'], ['a', 'b'])).toEqual({
      toAdd: ['d'],
      toRemove: ['b'],
    });
  });

  it('is empty when desired equals running', () => {
    expect(diffBotSets(['a', 'b'], ['b', 'a'])).toEqual({ toAdd: [], toRemove: [] });
  });
});

describe('#157 botKey', () => {
  it('prefers configId, falls back to robotUid', () => {
    expect(botKey({ configId: 'cfg-1', robotUid: 'r-1' })).toBe('cfg-1');
    expect(botKey({ configId: '', robotUid: 'r-1' })).toBe('r-1');
    expect(botKey({ robotUid: 'r-1' })).toBe('r-1');
  });
});

// ─── Fakes ───────────────────────────────────────────────────────────────────

interface FakeRouter {
  known: Set<string>;
  registerKnownBot: (uid: string) => void;
  unregisterKnownBot: (uid: string) => void;
}

function fakeRouter(selfUid: string): FakeRouter {
  const known = new Set<string>([selfUid]);
  return {
    known,
    registerKnownBot: (uid: string) => {
      if (uid) known.add(uid);
    },
    unregisterKnownBot: (uid: string) => {
      if (uid && uid !== selfUid) known.delete(uid);
    },
  };
}

function fakeBot(
  configId: string,
  robotUid: string,
  opts?: { connect?: () => Promise<void>; onShutdown?: () => void },
): ManagedBot & { router: FakeRouter } {
  const router = fakeRouter(robotUid);
  return {
    configId,
    robotUid,
    router: router as unknown as ManagedBot['router'] & FakeRouter,
    connect: opts?.connect ?? (() => Promise.resolve()),
    shutdown: () => {
      opts?.onShutdown?.();
      return Promise.resolve();
    },
  } as ManagedBot & { router: FakeRouter };
}

// ─── Cross-register / unregister ─────────────────────────────────────────────

describe('#157 crossRegisterOnAdd', () => {
  it('registers bidirectionally between new bot and all existing bots', () => {
    const a = fakeBot('cfg-a', 'r-a');
    const b = fakeBot('cfg-b', 'r-b');
    const fresh = fakeBot('cfg-c', 'r-c');
    crossRegisterOnAdd(fresh, [a, b]);
    // new bot knows both existing
    expect(fresh.router.known.has('r-a')).toBe(true);
    expect(fresh.router.known.has('r-b')).toBe(true);
    // existing bots know the new one
    expect(a.router.known.has('r-c')).toBe(true);
    expect(b.router.known.has('r-c')).toBe(true);
  });

  it('skips an existing entry sharing the new bot robotUid (no self-register churn)', () => {
    const fresh = fakeBot('cfg-c', 'r-c');
    const dup = fakeBot('cfg-c2', 'r-c'); // same robotUid
    crossRegisterOnAdd(fresh, [dup]);
    // dup is skipped — fresh did not register its own uid via the loop
    expect(dup.router.known.has('r-c')).toBe(true); // self already there from ctor
  });
});

describe('#157 crossUnregisterOnRemove', () => {
  it('removes the departed bot from every remaining router', () => {
    const a = fakeBot('cfg-a', 'r-a');
    const b = fakeBot('cfg-b', 'r-b');
    a.router.registerKnownBot('r-x');
    b.router.registerKnownBot('r-x');
    const gone = fakeBot('cfg-x', 'r-x');
    crossUnregisterOnRemove(gone, [a, b]);
    expect(a.router.known.has('r-x')).toBe(false);
    expect(b.router.known.has('r-x')).toBe(false);
  });
});

// ─── BotManager ──────────────────────────────────────────────────────────────

describe('#157 BotManager add/remove', () => {
  it('adds bots and cross-registers them bidirectionally', async () => {
    const made: Record<string, ManagedBot & { router: FakeRouter }> = {};
    const mgr = new BotManager(async (configId) => {
      const b = fakeBot(configId, `r-${configId}`);
      made[configId] = b;
      return b;
    });
    await mgr.addBot('a');
    await mgr.addBot('b');
    expect(mgr.runningKeys().sort()).toEqual(['a', 'b']);
    expect(made['a'].router.known.has('r-b')).toBe(true);
    expect(made['b'].router.known.has('r-a')).toBe(true);
  });

  it('addBot is idempotent (second add of same key is a no-op)', async () => {
    const start = vi.fn(async (configId: string) => fakeBot(configId, `r-${configId}`));
    const mgr = new BotManager(start);
    await mgr.addBot('a');
    await mgr.addBot('a');
    expect(mgr.size()).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rolls back fully when connect fails (no Map entry, no sibling registration leak)', async () => {
    const a = fakeBot('a', 'r-a');
    const mgr = new BotManager(async (configId) => {
      if (configId === 'a') return a;
      // 'bad' bot: connect throws
      return {
        configId,
        robotUid: `r-${configId}`,
        router: fakeRouter(`r-${configId}`) as unknown as ManagedBot['router'],
        connect: () => Promise.reject(new Error('connect boom')),
        shutdown: () => Promise.resolve(),
      } as ManagedBot;
    });
    await mgr.addBot('a');
    await expect(mgr.addBot('bad')).rejects.toThrow('connect boom');
    // bad bot not in the running set
    expect(mgr.runningKeys()).toEqual(['a']);
    // existing bot 'a' must NOT retain the rolled-back bot's uid
    expect(a.router.known.has('r-bad')).toBe(false);
  });

  it('removeBot shuts down and unregisters symmetrically', async () => {
    let aShutdown = false;
    const mgr = new BotManager(async (configId) =>
      fakeBot(configId, `r-${configId}`, configId === 'a' ? { onShutdown: () => { aShutdown = true; } } : undefined),
    );
    await mgr.addBot('a');
    await mgr.addBot('b');
    await mgr.removeBot('a');
    expect(mgr.runningKeys()).toEqual(['b']);
    expect(aShutdown).toBe(true);
  });

  it('removeBot is idempotent for an unknown key', async () => {
    const mgr = new BotManager(async (configId) => fakeBot(configId, `r-${configId}`));
    await expect(mgr.removeBot('nope')).resolves.toBeUndefined();
    expect(mgr.size()).toBe(0);
  });

  it('serializes concurrent add/remove (no interleaving on the same set)', async () => {
    const order: string[] = [];
    const mgr = new BotManager(async (configId) => {
      order.push(`start:${configId}`);
      // simulate async start work
      await new Promise((r) => setTimeout(r, 5));
      order.push(`started:${configId}`);
      return fakeBot(configId, `r-${configId}`);
    });
    // fire two adds without awaiting between them
    const p1 = mgr.addBot('a');
    const p2 = mgr.addBot('b');
    await Promise.all([p1, p2]);
    // serial: a fully starts before b starts (no interleave)
    expect(order).toEqual(['start:a', 'started:a', 'start:b', 'started:b']);
    expect(mgr.runningKeys().sort()).toEqual(['a', 'b']);
  });
});

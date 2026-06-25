/**
 * BotManager — runtime registry of live bots for hot-reload (#157).
 *
 * Owns a long-lived `Map<configId, BotStack>` so the gateway can add/remove a
 * single bot at runtime (driven by a config.json watcher) instead of a full
 * process restart. Holds the two-identity discipline (plan B2): the Map is
 * keyed by configId (config.json `bots[].id`), while the SessionRouter loop
 * guard is keyed by robotUid (Octo register id) — never mixed.
 *
 * Concurrency (plan C/C6): all mutations funnel through a single serial queue
 * (`enqueue`), so a watcher burst can never run two add/remove against the same
 * set concurrently. The diff is computed INSIDE the queued task against the
 * freshly-loaded desired set, never precomputed in the watcher callback.
 */
import type { SessionRouter } from './session-router.js';

/** The subset of a started bot the manager needs to track and tear down. */
export interface ManagedBot {
  configId?: string;
  robotUid: string;
  router: SessionRouter;
  connect: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/** A desired bot entry from config (just its identity for diffing). */
export interface DesiredBot {
  /** config.json bots[].id — the diff key. */
  configId: string;
}

/**
 * Diff a desired config-id set against the currently-running config-id set.
 * Pure so the watcher's core decision is unit-testable.
 *
 * Returns the configIds to add (in desired, not running) and to remove (running,
 * not in desired). Order within each list is the input order of `desired` /
 * `running` respectively.
 */
export function diffBotSets(
  desired: readonly string[],
  running: readonly string[],
): { toAdd: string[]; toRemove: string[] } {
  const runningSet = new Set(running);
  const desiredSet = new Set(desired);
  const toAdd = desired.filter((id) => !runningSet.has(id));
  const toRemove = running.filter((id) => !desiredSet.has(id));
  return { toAdd, toRemove };
}

/**
 * Key a bot stack for the manager Map. configId is preferred; fall back to
 * robotUid only when a config has no explicit id (single-bot legacy). Pure.
 */
export function botKey(bot: { configId?: string; robotUid: string }): string {
  return bot.configId && bot.configId.length > 0 ? bot.configId : bot.robotUid;
}

/**
 * Cross-register the loop-guard known-bot uids for a newly-added bot:
 *  - the new bot's router learns every existing bot's robotUid, AND
 *  - every existing bot's router learns the new bot's robotUid.
 * Bidirectional — a one-way register would let one side treat the other's
 * messages as user input in a mention-free group (plan B). Pure over the
 * passed collections (no I/O), so it is unit-testable.
 */
export function crossRegisterOnAdd(
  newBot: ManagedBot,
  existing: readonly ManagedBot[],
): void {
  for (const e of existing) {
    if (e.robotUid === newBot.robotUid) continue;
    newBot.router.registerKnownBot(e.robotUid);
    e.router.registerKnownBot(newBot.robotUid);
  }
}

/** Symmetric teardown: every remaining bot's router forgets the removed bot. */
export function crossUnregisterOnRemove(
  removed: ManagedBot,
  remaining: readonly ManagedBot[],
): void {
  for (const r of remaining) {
    r.router.unregisterKnownBot(removed.robotUid);
  }
}

/** How a managed bot is brought up from a config entry (injected for tests). */
export type StartFn = (configId: string) => Promise<ManagedBot>;

/**
 * Runtime registry + serial mutation queue for live bots.
 *
 * The manager never opens sockets itself — `StartFn` (wired to startBot in
 * index.ts) does the register+handler work and returns a ManagedBot whose
 * `connect()` opens the socket. addBot enforces the plan-B ordering:
 *   start (register+handler, no socket) → cross-register known bots → connect,
 * with rollback if connect throws.
 */
export class BotManager {
  private readonly bots = new Map<string, ManagedBot>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly start: StartFn) {}

  /** Snapshot of currently-running config keys (Map keys). */
  runningKeys(): string[] {
    return [...this.bots.keys()];
  }

  size(): number {
    return this.bots.size;
  }

  has(key: string): boolean {
    return this.bots.has(key);
  }

  /** Run a mutation on the serial queue so add/remove never interleave. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive even if a task rejects (so later tasks still run),
    // but propagate the result/rejection to this call's awaiter.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Add one bot by configId: start → cross-register → connect, rolling back all
   * three on any failure so a half-added bot never lingers in the Map or in
   * sibling routers' known-bot sets.
   */
  addBot(configId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.bots.has(configId)) return; // idempotent — already running
      const bot = await this.start(configId);
      const existing = [...this.bots.values()];
      crossRegisterOnAdd(bot, existing);
      try {
        await bot.connect();
      } catch (err) {
        // Roll back: undo the cross-registration, tear the bot down, leave the
        // set exactly as it was before this addBot.
        crossUnregisterOnRemove(bot, existing);
        await bot.shutdown().catch(() => {});
        throw err;
      }
      this.bots.set(configId, bot);
    });
  }

  /** Remove one bot by configId: shutdown + symmetric unregister + drop. */
  removeBot(configId: string): Promise<void> {
    return this.enqueue(async () => {
      const bot = this.bots.get(configId);
      if (!bot) return; // idempotent — already gone
      this.bots.delete(configId);
      const remaining = [...this.bots.values()];
      crossUnregisterOnRemove(bot, remaining);
      await bot.shutdown().catch(() => {});
    });
  }
}


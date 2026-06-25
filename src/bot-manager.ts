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

/**
 * The subset of a started bot the manager needs to track and tear down. The
 * manager keys bots by the configId passed to addBot (not a field here), and the
 * loop-guard uses robotUid — so configId is intentionally NOT carried on the
 * stack (it would be a write-only field; see plan B2 for the identity split).
 */
export interface ManagedBot {
  robotUid: string;
  router: SessionRouter;
  connect: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Diff a desired config-id set against the currently-running config-id set.
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
  // Set by shutdownAll() so any apply task that was already past the watcher's
  // `closed` guard can't re-add a bot after teardown has begun (plan E / N4
  // shutdown race). Once true, addBot is a permanent no-op.
  private shuttingDown = false;

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
      if (this.shuttingDown) return; // teardown started — don't resurrect bots
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
      // Symmetric inverse of addBot's ordering: close the socket FIRST, then let
      // siblings forget this bot. If we unregistered before shutdown, the bot's
      // in-flight handlers (still draining for up to the gateway drain timeout)
      // could emit replies that siblings — having already dropped its robotUid —
      // would treat as user input, reopening the very loop the guard prevents.
      await bot.shutdown().catch(() => {});
      crossUnregisterOnRemove(bot, remaining);
    });
  }

  /**
   * Bring up several bots as ONE two-phase batch: start every bot (register +
   * handler, NO socket) → cross-register the whole set's loop-guard uids
   * pairwise → connect them all. This preserves the "no bot opens its socket
   * before every sibling knows its robotUid" invariant ACROSS the initial set —
   * adding bots one-by-one via addBot would let the first bot connect before
   * later bots exist, so it would never learn them. A bot that fails to start or
   * connect is rolled back and skipped (resilience); the rest still come up.
   * Returns the configIds that failed.
   */
  addBotsBatch(configIds: readonly string[]): Promise<{ failed: { configId: string; error: unknown }[] }> {
    return this.enqueue(async () => {
      const failed: { configId: string; error: unknown }[] = [];
      if (this.shuttingDown) {
        return { failed: configIds.map((configId) => ({ configId, error: new Error('shutting down') })) };
      }
      // Phase 1: start (register + handler, no socket) every not-yet-running bot.
      const started: { configId: string; bot: ManagedBot }[] = [];
      for (const configId of configIds) {
        if (this.bots.has(configId)) continue; // already running — skip
        try {
          started.push({ configId, bot: await this.start(configId) });
        } catch (error) {
          failed.push({ configId, error });
        }
      }
      // Phase 2: cross-register loop-guard uids across the existing set AND the
      // whole freshly-started batch, BEFORE any socket opens.
      const existing = [...this.bots.values()];
      const batch = started.map((s) => s.bot);
      for (const s of started) {
        crossRegisterOnAdd(s.bot, [...existing, ...batch]);
      }
      // Phase 3: connect every started bot. A connect failure rolls back just
      // that bot (unregister from everyone + shutdown) and is reported.
      for (const s of started) {
        try {
          await s.bot.connect();
          this.bots.set(s.configId, s.bot);
        } catch (error) {
          crossUnregisterOnRemove(s.bot, [...existing, ...batch.filter((b) => b !== s.bot)]);
          await s.bot.shutdown().catch(() => {});
          failed.push({ configId: s.configId, error });
        }
      }
      return { failed };
    });
  }

  /**
   * Shut down every running bot (process exit). Drains them concurrently — order
   * doesn't matter at teardown — and clears the Map. Runs on the serial queue so
   * it can't interleave with an in-flight add/remove.
   */
  shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    return this.enqueue(async () => {
      const all = [...this.bots.values()];
      this.bots.clear();
      await Promise.allSettled(all.map((b) => b.shutdown()));
    });
  }
}


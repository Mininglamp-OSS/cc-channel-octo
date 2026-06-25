/**
 * Config watcher — drives BotManager from config.json changes (#157).
 *
 * Watches the global config's directory (not the file directly: an atomic
 * temp+rename swaps the inode, and a file-targeted fs.watch would stop firing
 * after the first rename). On any change it schedules a debounced, serialized
 * `applyLatestConfig`, which RE-READS the latest config inside the task (never
 * a precomputed diff — plan C6) and reconciles the running set toward it.
 *
 * Robustness (plan D): the desired set is produced by a single `loadDesired`
 * call; if it throws for ANY reason (half-written file, JSON error, missing
 * token, duplicate id, unsafe apiUrl, broken per-bot config), the current
 * running set is left untouched — a bad edit never tears down healthy bots.
 */
import { watch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { diffBotSets } from './bot-manager.js';

/** Minimal manager surface the watcher needs (eases testing). */
export interface Reconcilable {
  runningKeys(): string[];
  addBot(configId: string): Promise<void>;
  removeBot(configId: string): Promise<void>;
}

/**
 * Reconcile the running set toward `desiredConfigIds` once. Removes first, then
 * adds, so a config that swaps a bot for another with an overlapping resource
 * (lock/dir) frees it before the replacement claims it. Add/remove failures are
 * logged and swallowed so one bad bot doesn't abort the whole reconcile; the
 * BotManager queue keeps the set consistent. Pure-ish (no fs) for unit testing.
 *
 * `isStale` is checked before each add/remove: a newer config event makes the
 * in-flight reconcile abandon its remaining (now outdated) actions, so a bot
 * removed by a later edit is never started by an earlier, slower reconcile
 * (plan C6 generation guard).
 */
export async function reconcile(
  manager: Reconcilable,
  desiredConfigIds: readonly string[],
  log: (msg: string) => void = () => {},
  isStale: () => boolean = () => false,
): Promise<void> {
  const { toAdd, toRemove } = diffBotSets(desiredConfigIds, manager.runningKeys());
  for (const id of toRemove) {
    if (isStale()) {
      log(`[hot-reload] reconcile superseded by a newer config, stopping`);
      return;
    }
    try {
      await manager.removeBot(id);
      log(`[hot-reload] removed bot ${id}`);
    } catch (err) {
      log(`[hot-reload] removeBot ${id} failed: ${errMsg(err)}`);
    }
  }
  for (const id of toAdd) {
    if (isStale()) {
      log(`[hot-reload] reconcile superseded by a newer config, stopping`);
      return;
    }
    try {
      await manager.addBot(id);
      log(`[hot-reload] added bot ${id}`);
    } catch (err) {
      log(`[hot-reload] addBot ${id} failed: ${errMsg(err)}`);
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface WatcherHandle {
  /** Force an immediate reconcile (bypasses debounce). For tests / initial sync. */
  applyNow(): Promise<void>;
  close(): void;
}

export interface WatchOptions {
  /** Absolute path to the global config.json. */
  configPath: string;
  manager: Reconcilable;
  /**
   * Produce the desired configId list from disk. MUST throw on any invalid
   * config so the watcher can keep the current set (plan D). Typically wraps
   * loadConfig + resolveBotConfigs and maps to `bots[].id`.
   */
  loadDesired: () => readonly string[];
  /** Debounce window in ms (coalesce a burst of writes). Default 200. */
  debounceMs?: number;
  log?: (msg: string) => void;
}

/**
 * Start watching `configPath`'s directory and reconcile on change.
 *
 * Serialization & staleness: a single `chain` promise serializes apply runs,
 * and each run re-reads the latest config at execution time, so a burst of
 * events collapses to "apply the newest state" rather than replaying each
 * intermediate edit. The BotManager's own queue further serializes the
 * resulting add/remove calls.
 */
export function watchConfig(opts: WatchOptions): WatcherHandle {
  const { configPath, manager, loadDesired } = opts;
  const debounceMs = opts.debounceMs ?? 200;
  const log = opts.log ?? (() => {});
  const dir = dirname(configPath);
  const file = basename(configPath);

  let chain: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  // Generation guard (plan C6): every scheduled change bumps `latestGen`. An
  // apply task captures the gen at enqueue time; if a newer event arrives while
  // it is mid-reconcile, its captured gen != latestGen and it abandons its
  // remaining actions, so a slow reconcile never applies a stale desired set.
  let latestGen = 0;

  const apply = (): Promise<void> => {
    const myGen = ++latestGen;
    // Re-read latest desired set INSIDE the serialized task (plan C6). Any
    // failure (half-write / invalid config) leaves the running set untouched.
    chain = chain.then(async () => {
      if (closed) return;
      let desired: readonly string[];
      try {
        desired = loadDesired();
      } catch (err) {
        log(`[hot-reload] config invalid, keeping current bots: ${errMsg(err)}`);
        return;
      }
      await reconcile(manager, desired, log, () => closed || myGen !== latestGen);
    });
    return chain;
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void apply();
    }, debounceMs);
    timer.unref?.();
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, (_event, changed) => {
      // Only react to our config file (the dir may hold per-bot subdirs etc.).
      // changed is null on some platforms — be permissive and reconcile then.
      if (changed === null || changed === file) schedule();
    });
    watcher.on('error', (err) => log(`[hot-reload] watcher error: ${errMsg(err)}`));
  } catch (err) {
    log(`[hot-reload] failed to start watcher on ${dir}: ${errMsg(err)}`);
  }

  return {
    applyNow: apply,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
    },
  };
}

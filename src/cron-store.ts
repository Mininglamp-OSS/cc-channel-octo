/**
 * #115: Per-bot cron task persistence — `<baseDir>/<botId>/cron.json`.
 *
 * Holds the scheduled tasks a bot's agent has registered via the cron tool. Read
 * by both the cron tool (agent turn, under the session lock) and the scheduler
 * tick (every ~30s). Node is single-threaded and all I/O here is synchronous, so
 * a tool write and a scheduler read can never interleave mid-operation; the
 * atomic temp+rename below additionally guarantees a reader never sees a partial
 * file even across a crash.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ChannelType } from './octo/types.js';

/** One scheduled task. Persisted as a plain JSON object. */
export interface CronTask {
  /** Stable handle (uuid) — used by cron_delete; not user-chosen. */
  id: string;
  /** 5-field cron expression OR a one-shot ISO datetime. */
  schedule: string;
  /** true = re-schedule after each fire; false = delete after firing once. */
  recurring: boolean;
  /** Prompt injected as the synthetic message's text (≤ MAX_PROMPT_BYTES). */
  prompt: string;
  /** Bound session coords — where the fired task runs and replies. */
  channelId: string;
  channelType: ChannelType;
  fromUid: string;
  fromName?: string;
  /** uid that registered the task (owner-gate source of truth). */
  createdBy: string;
  /** Scheduler skips disabled tasks (kept for a future cron_disable). */
  enabled: boolean;
  /** Unix ms of creation. */
  createdAt: number;
  /** Unix ms of the last fire, or null if never fired. */
  lastRun: number | null;
  /** Unix ms of the next fire (the scheduler's due check), or null if none. */
  nextRun: number | null;
}

/** Max prompt size (bytes) accepted into a task. */
export const MAX_PROMPT_BYTES = 2048;
/** Max number of tasks per bot. */
export const MAX_TASKS_PER_BOT = 50;

/** Load/save a single bot's cron.json. */
export class CronStore {
  constructor(private readonly cronJsonPath: string) {}

  /** Parse cron.json. Throws on malformed JSON (loud, not silent). */
  load(): CronTask[] {
    const raw = readFileSync(this.cronJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`cron.json is not an array: ${this.cronJsonPath}`);
    }
    return parsed as CronTask[];
  }

  /** Like load(), but returns [] when the file does not exist. */
  loadOrEmpty(): CronTask[] {
    if (!existsSync(this.cronJsonPath)) return [];
    return this.load();
  }

  /** Atomically write the task array (temp file + rename). */
  save(tasks: CronTask[]): void {
    const tmp = `${this.cronJsonPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), { mode: 0o600 });
    renameSync(tmp, this.cronJsonPath);
  }

  /**
   * Atomic read-modify-write: load the current tasks, apply `mutator`, persist
   * the result, and return it. The whole sequence runs **synchronously** (no
   * await), so under Node's single-threaded model no other turn or scheduler
   * tick can interleave between the load and the save — eliminating the
   * lost-update race that separate load()+save() calls would risk if a caller
   * ever introduced an await between them. All cron mutations (create, delete,
   * scheduler advance) go through this one method.
   */
  update(mutator: (tasks: CronTask[]) => CronTask[]): CronTask[] {
    const current = this.loadOrEmpty();
    const next = mutator(current);
    // Skip the write when the mutator returns the same array reference
    // unchanged (e.g. an idle scheduler tick with nothing due) — avoids
    // rewriting cron.json on every 30s tick.
    if (next !== current) this.save(next);
    return next;
  }
}

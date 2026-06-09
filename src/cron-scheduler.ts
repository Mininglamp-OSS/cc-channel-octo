/**
 * #115: Cron scheduler — a resident per-bot loop that fires due tasks.
 *
 * Every tick it loads the bot's cron.json, and for each enabled task whose
 * `nextRun` is past, synthesizes a BotMessage (the task's prompt as a Text
 * message, bound to the task's session coords, marked `_cronFire`) and hands it
 * to `onFire` — which the gateway wires to the same `onInbound` real messages
 * use, so a fired task runs through the entire normal pipeline.
 *
 * Best-effort throughout: a failing task is logged and skipped, never crashing
 * the loop. Missed tasks (process was down across their window) fire ONCE on
 * catch-up, then advance to the next future occurrence — no thundering herd.
 */

import type { BotMessage } from './octo/types.js';
import { MessageType } from './octo/types.js';
import type { ChannelType } from './octo/types.js';
import { CronStore, type CronTask } from './cron-store.js';
import { computeNextRun } from './cron-evaluator.js';
import { CRON_FIRE_NONCE, CRON_FIRE_NONCE_KEY } from './cron-fire-marker.js';

/** How often the scheduler scans cron.json (ms). 30s → ≤30s firing latency. */
export const CRON_TICK_MS = 30_000;

export interface CronSchedulerOptions {
  cronStore: CronStore;
  /** Invoked with a synthetic BotMessage when a task is due (= onInbound). */
  onFire: (msg: BotMessage) => void;
  /** Log prefix, e.g. "[bot-id] " in multi-bot mode. */
  label?: string;
}

/** Build the synthetic inbound message for a fired task. */
export function synthesizeCronMessage(task: CronTask): BotMessage {
  return {
    message_id: `cron:${task.id}:${Date.now()}`,
    message_seq: 0,
    from_uid: task.fromUid,
    from_name: task.fromName,
    channel_id: task.channelId,
    channel_type: task.channelType as ChannelType,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: task.prompt,
      // Synthetic marker + per-process nonce: lets the router bypass the group
      // @mention gate for genuine in-process cron fires only (see
      // session-router isCronFire / cron-fire-marker). A forged inbound payload
      // can set `_cronFire` but cannot know the secret nonce. Allowed by the
      // MessagePayload index signature; never set on real inbound messages.
      _cronFire: true,
      [CRON_FIRE_NONCE_KEY]: CRON_FIRE_NONCE,
    },
  };
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: CronSchedulerOptions) {}

  /** Arm the periodic scan. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), CRON_TICK_MS);
    this.timer.unref(); // never keep the process alive on the cron loop alone
  }

  /** Stop scanning. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One scan: fire due tasks, advance/drop them, persist. Exposed for tests.
   * Never throws.
   */
  tick(): void {
    const now = Date.now();
    // Single atomic read-modify-write: fire due tasks and persist the survivor
    // set in one synchronous pass, so a concurrent tool create/delete (which
    // also goes through cronStore.update) can't lose updates against us.
    try {
      this.opts.cronStore.update((tasks) => {
        const survivors: CronTask[] = [];
        let changed = false;
        for (const task of tasks) {
          if (!task.enabled || task.nextRun === null || task.nextRun > now) {
            survivors.push(task);
            continue;
          }
          changed = true;
          // Due. Fire (best-effort; onFire is fire-and-forget).
          const lateMin = Math.round((now - task.nextRun) / 60_000);
          if (lateMin >= 1) {
            console.warn(
              `[cc-channel-octo] ${this.opts.label ?? ''}cron: task ${task.id} (${task.schedule}) ` +
                `fired ${lateMin} min late (catch-up)`,
            );
          }
          try {
            this.opts.onFire(synthesizeCronMessage(task));
          } catch (err) {
            console.error(
              `[cc-channel-octo] ${this.opts.label ?? ''}cron: onFire threw for ${task.id}: ${String(err)}`,
            );
          }
          task.lastRun = now;
          if (task.recurring) {
            task.nextRun = computeNextRun(task.schedule, true, now);
            survivors.push(task); // keep; next future occurrence (or null → inert)
          }
          // one-shot: drop (not pushed to survivors)
        }
        // Return the SAME reference when nothing fired so update() skips the write.
        return changed ? survivors : tasks;
      });
    } catch (err) {
      console.error(`[cc-channel-octo] ${this.opts.label ?? ''}cron: tick failed: ${String(err)}`);
    }
  }
}

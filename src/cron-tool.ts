/**
 * #115: Cron tool — an in-process MCP server letting the agent register, list,
 * and delete per-bot scheduled tasks. Tools surface to the model as
 * `mcp__cron__cron_create` / `_list` / `_delete`.
 *
 * The server is built PER TURN (`createCronToolServer`) with the current
 * message's raw channel coords + the bot owner uid, so:
 *  - a created task BINDS to the session that created it (fires + replies there);
 *  - creation/deletion is GATED to the bot owner (registerBot.owner_uid). The
 *    agent is driven by untrusted IM users, so this server-side check — not LLM
 *    judgment — is what stops a prompt-injected agent from registering a
 *    malicious recurring task. (See SECURITY_PROMPT_PREFIX for the advisory
 *    defense-in-depth layer.)
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelType } from './octo/types.js';
import { CronStore, MAX_PROMPT_BYTES, MAX_TASKS_PER_BOT, type CronTask } from './cron-store.js';
import { computeNextRun, isOneShotSchedule, parseCronExpression } from './cron-evaluator.js';

/** MCP server name; tools surface as `mcp__cron__<tool>`. */
export const CRON_TOOL_SERVER_NAME = 'cron';

/** Raw coords of the session creating a task — what a fired task binds to. */
export interface CronSessionCoords {
  channelId: string;
  channelType: ChannelType;
  fromUid: string;
  fromName?: string;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/** A task rendered for the model (nextRun as ISO, no internal-only churn). */
function summarize(t: CronTask): Record<string, unknown> {
  return {
    id: t.id,
    schedule: t.schedule,
    recurring: t.recurring,
    prompt: t.prompt,
    nextRun: t.nextRun ? new Date(t.nextRun).toISOString() : null,
    enabled: t.enabled,
  };
}

/**
 * Build the cron tool DEFINITIONS for one agent turn. Exported separately from
 * the server so tests can invoke each handler directly (the MCP server keeps its
 * tools in private internals). `coords` binds created tasks to this session;
 * `ownerUid` gates create/delete to the bot owner.
 */
export function buildCronTools(
  cronStore: CronStore,
  coords: CronSessionCoords,
  ownerUid: string,
) {
  const isOwner = coords.fromUid === ownerUid && ownerUid !== '';

  return [
      tool(
        'cron_create',
        'Schedule a task: at the given time the bot re-runs `prompt` in THIS chat, ' +
          'as if you received it as a message, and posts the result here. ' +
          '`schedule` is a 5-field cron expression ("0 9 * * 1-5" = weekdays 9am) ' +
          'or a one-shot ISO datetime ("2026-06-09T09:00:00Z"). Set recurring=false ' +
          'for a one-time reminder. Only the bot owner may create tasks.',
        {
          schedule: z.string().min(1).describe('5-field cron expression or one-shot ISO datetime.'),
          prompt: z.string().min(1).describe('The instruction to run when the task fires.'),
          recurring: z.boolean().optional().describe('Re-run on every match (default: cron→true, one-shot→false).'),
        },
        async (args) => {
          try {
            if (!isOwner) {
              return errResult('Only the bot owner can create scheduled tasks.');
            }
            const oneShot = isOneShotSchedule(args.schedule);
            // Validate the schedule.
            if (!oneShot && !parseCronExpression(args.schedule)) {
              return errResult(`Invalid cron expression: ${args.schedule}`);
            }
            if (Buffer.byteLength(args.prompt, 'utf8') > MAX_PROMPT_BYTES) {
              return errResult(`prompt too long (max ${MAX_PROMPT_BYTES} bytes).`);
            }
            const recurring = args.recurring ?? !oneShot;
            const now = Date.now();
            const nextRun = computeNextRun(args.schedule, recurring, now);
            if (nextRun === null) {
              return errResult(
                oneShot
                  ? 'one-shot time is in the past or invalid.'
                  : `schedule never matches (impossible cron): ${args.schedule}`,
              );
            }
            const tasks = cronStore.loadOrEmpty();
            if (tasks.length >= MAX_TASKS_PER_BOT) {
              return errResult(`task limit reached (max ${MAX_TASKS_PER_BOT}). Delete one first.`);
            }
            const task: CronTask = {
              id: crypto.randomUUID(),
              schedule: args.schedule,
              recurring,
              prompt: args.prompt,
              channelId: coords.channelId,
              channelType: coords.channelType,
              fromUid: coords.fromUid,
              fromName: coords.fromName,
              createdBy: coords.fromUid,
              enabled: true,
              createdAt: now,
              lastRun: null,
              nextRun,
            };
            tasks.push(task);
            cronStore.save(tasks);
            return jsonResult({ created: summarize(task) });
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err));
          }
        },
      ),
      tool(
        'cron_list',
        'List the scheduled tasks bound to this bot.',
        {},
        async () => {
          try {
            return jsonResult({ tasks: cronStore.loadOrEmpty().map(summarize) });
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err));
          }
        },
      ),
      tool(
        'cron_delete',
        'Delete a scheduled task by its id. Only the bot owner may delete tasks.',
        { id: z.string().min(1).describe('The task id (from cron_list).') },
        async (args) => {
          try {
            if (!isOwner) {
              return errResult('Only the bot owner can delete scheduled tasks.');
            }
            const tasks = cronStore.loadOrEmpty();
            const next = tasks.filter((t) => t.id !== args.id);
            if (next.length === tasks.length) {
              return errResult(`no task with id ${args.id}`);
            }
            cronStore.save(next);
            return jsonResult({ deleted: args.id });
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err));
          }
        },
      ),
  ];
}

/**
 * Build the cron MCP server for one agent turn. `coords` binds created tasks to
 * this session; `ownerUid` gates create/delete to the bot owner.
 */
export function createCronToolServer(
  cronStore: CronStore,
  coords: CronSessionCoords,
  ownerUid: string,
) {
  return createSdkMcpServer({
    name: CRON_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildCronTools(cronStore, coords, ownerUid),
  });
}

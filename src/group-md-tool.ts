/**
 * P2-C: GROUP.md write-back tool — an in-process MCP server letting the agent
 * persist an updated GROUP.md back to the server. The tool surfaces to the model
 * as `mcp__group_md__update_group_md`.
 *
 * The server is built PER TURN (`createGroupMdToolServer`) with the current
 * message's channel coords + the bot owner uid, so:
 *  - the write targets the PARENT group of the channel the agent is in
 *    (`extractParentGroupNo` — a thread shares its parent group's GROUP.md);
 *  - invocation is GATED to the bot owner (registerBot.owner_uid). The group's
 *    octo_tag token has server-side write permission, but the agent is driven by
 *    untrusted IM users, so this owner gate — not LLM judgment, and independent
 *    of the token's group-role permission — is what stops a prompt-injected
 *    agent from rewriting the operator's trusted GROUP.md from any chat.
 *
 * Concurrency, the byte ceiling, and the cache refresh are owned by the shared
 * {@link GroupMdWriteback} coordinator (group-md-writeback.ts); this layer is
 * only the owner-gate policy + the MCP surface.
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  extractParentGroupNo,
  extractThreadShortId,
  isThreadChannelId,
} from './octo/channel-id.js';
import {
  GroupMdContentTooLargeError,
  MAX_GROUP_MD_CONTENT_BYTES,
  ThreadMdContentTooLargeError,
  MAX_THREAD_MD_CONTENT_BYTES,
  type GroupMdWriteback,
  type ThreadMdWriteback,
} from './group-md-writeback.js';

/** MCP server name; the tool surfaces as `mcp__group_md__update_group_md`. */
export const GROUP_MD_TOOL_SERVER_NAME = 'group_md';

/** MCP server name; the tool surfaces as `mcp__thread_md__update_thread_md`. */
export const THREAD_MD_TOOL_SERVER_NAME = 'thread_md';

/** Raw coords of the session invoking the tool — gates the call + targets the group. */
export interface GroupMdSessionCoords {
  /** Full channelId (may be a `<groupNo>____<shortId>` thread composite). */
  channelId: string;
  fromUid: string;
  fromName?: string;
}

/** Shared deps the tool needs to perform a write-back. */
export interface GroupMdToolDeps {
  writeback: GroupMdWriteback;
  apiUrl: string;
  botToken: string;
}

/** Shared deps the thread write-back tool needs. */
export interface ThreadMdToolDeps {
  writeback: ThreadMdWriteback;
  apiUrl: string;
  botToken: string;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errResult(msg: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

/**
 * Build the GROUP.md tool DEFINITIONS for one agent turn. Exported separately
 * from the server so tests can invoke the handler directly. `coords` targets the
 * group + supplies the caller uid; `ownerUid` is the owner gate.
 */
export function buildGroupMdTools(
  deps: GroupMdToolDeps,
  coords: GroupMdSessionCoords,
  ownerUid: string,
) {
  const isOwner = coords.fromUid === ownerUid && ownerUid !== '';

  return [
    tool(
      'update_group_md',
      'Persist new GROUP.md content for THIS group on the server (it becomes the ' +
        "group's trusted operator instructions on the next turn). `content` is the " +
        'FULL replacement document, not a diff. Hard limit: 10240 bytes UTF-8. Only ' +
        'the bot owner may call this; a non-owner request is rejected. Last write ' +
        'wins server-side — compose the complete updated document, do not assume a ' +
        'concurrent edit merged.',
      {
        content: z
          .string()
          .describe('Full replacement GROUP.md document (≤10240 bytes UTF-8).'),
      },
      async (args) => {
        try {
          if (!isOwner) {
            return errResult('Only the bot owner can update GROUP.md.');
          }
          const groupNo = extractParentGroupNo(coords.channelId);
          if (!groupNo) {
            return errResult('Could not resolve a group number from this channel.');
          }
          // Surface a friendly over-limit message before the coordinator throws
          // (it re-checks as the authoritative boundary; this is just for UX).
          const bytes = Buffer.byteLength(args.content, 'utf-8');
          if (bytes > MAX_GROUP_MD_CONTENT_BYTES) {
            return errResult(
              `content is ${bytes} bytes, over the ${MAX_GROUP_MD_CONTENT_BYTES}-byte ` +
                `UTF-8 limit — trim it before writing (the server would reject it).`,
            );
          }
          const res = await deps.writeback.writeBack({
            apiUrl: deps.apiUrl,
            botToken: deps.botToken,
            groupNo,
            content: args.content,
          });
          return jsonResult({
            updated: { groupNo: res.groupNo, version: res.version, bytes: res.bytes },
          });
        } catch (err) {
          if (err instanceof GroupMdContentTooLargeError) {
            return errResult(
              `content is ${err.bytes} bytes, over the ${MAX_GROUP_MD_CONTENT_BYTES}-byte UTF-8 limit.`,
            );
          }
          return errResult(err instanceof Error ? err.message : String(err));
        }
      },
    ),
  ];
}

/**
 * Build the GROUP.md write-back MCP server for one agent turn. `coords` targets
 * the group + supplies the caller uid; `ownerUid` is the owner gate.
 */
export function createGroupMdToolServer(
  deps: GroupMdToolDeps,
  coords: GroupMdSessionCoords,
  ownerUid: string,
) {
  return createSdkMcpServer({
    name: GROUP_MD_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildGroupMdTools(deps, coords, ownerUid),
  });
}

/**
 * Build the THREAD.md tool DEFINITIONS for one agent turn (P3-2). The thread
 * analogue of {@link buildGroupMdTools}: the tool surfaces as
 * `mcp__thread_md__update_thread_md` and writes THIS thread's OWN THREAD.md
 * (PUT /v1/bot/groups/{groupNo}/threads/{shortId}/md), NEVER the parent group's
 * GROUP.md — the thread/group split is mutually exclusive (#88 P3).
 * index.ts only ever wires the group tool OR this thread tool for a turn (chosen
 * by channelId shape), so the two never co-exist in one session.
 *
 * `coords.channelId` MUST be a thread composite (`<groupNo>____<shortId>`); the
 * caller (index.ts) guarantees this by routing on `isThreadChannelId`. The
 * owner-gate is identical to the group tool (bot-owner-only, independent of the
 * token's server-side thread permission).
 */
export function buildThreadMdTools(
  deps: ThreadMdToolDeps,
  coords: GroupMdSessionCoords,
  ownerUid: string,
) {
  const isOwner = coords.fromUid === ownerUid && ownerUid !== '';

  return [
    tool(
      'update_thread_md',
      'Persist new THREAD.md content for THIS thread (subarea) on the server (it ' +
        "becomes the thread's trusted operator instructions on the next turn). " +
        '`content` is the FULL replacement document, not a diff. Hard limit: 10240 ' +
        'bytes UTF-8. Only the bot owner may call this; a non-owner request is ' +
        'rejected. This writes the thread\'s OWN THREAD.md, never the parent ' +
        "group's GROUP.md. Last write wins server-side — compose the complete " +
        'updated document, do not assume a concurrent edit merged.',
      {
        content: z
          .string()
          .describe('Full replacement THREAD.md document (≤10240 bytes UTF-8).'),
      },
      async (args) => {
        try {
          if (!isOwner) {
            return errResult('Only the bot owner can update THREAD.md.');
          }
          if (!isThreadChannelId(coords.channelId)) {
            return errResult('This channel is not a thread — THREAD.md is only writable from a thread.');
          }
          const groupNo = extractParentGroupNo(coords.channelId);
          const shortId = extractThreadShortId(coords.channelId);
          if (!groupNo || !shortId) {
            return errResult('Could not resolve a thread (groupNo/shortId) from this channel.');
          }
          // Friendly over-limit message before the coordinator throws (it re-checks
          // as the authoritative boundary; this is just for UX).
          const bytes = Buffer.byteLength(args.content, 'utf-8');
          if (bytes > MAX_THREAD_MD_CONTENT_BYTES) {
            return errResult(
              `content is ${bytes} bytes, over the ${MAX_THREAD_MD_CONTENT_BYTES}-byte ` +
                `UTF-8 limit — trim it before writing (the server would reject it).`,
            );
          }
          const res = await deps.writeback.writeBack({
            apiUrl: deps.apiUrl,
            botToken: deps.botToken,
            groupNo,
            shortId,
            content: args.content,
          });
          return jsonResult({
            updated: {
              groupNo: res.groupNo,
              shortId: res.shortId,
              version: res.version,
              bytes: res.bytes,
            },
          });
        } catch (err) {
          if (err instanceof ThreadMdContentTooLargeError) {
            return errResult(
              `content is ${err.bytes} bytes, over the ${MAX_THREAD_MD_CONTENT_BYTES}-byte UTF-8 limit.`,
            );
          }
          return errResult(err instanceof Error ? err.message : String(err));
        }
      },
    ),
  ];
}

/**
 * Build the THREAD.md write-back MCP server for one agent turn. `coords` targets
 * the thread (its composite channelId) + supplies the caller uid; `ownerUid` is
 * the owner gate.
 */
export function createThreadMdToolServer(
  deps: ThreadMdToolDeps,
  coords: GroupMdSessionCoords,
  ownerUid: string,
) {
  return createSdkMcpServer({
    name: THREAD_MD_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildThreadMdTools(deps, coords, ownerUid),
  });
}

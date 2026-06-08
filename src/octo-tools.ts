/**
 * Octo management agent tools (#87) — READ-ONLY phase.
 *
 * Registers an in-process MCP server exposing a few Octo group/member lookups to
 * the agent, so the model can answer "which groups am I in?", "who's in this
 * group?", "find user X" without the operator pre-wiring anything. Backed by the
 * existing read-only REST in octo/api.ts.
 *
 * Scope is deliberately read-only this round — no group/member/thread mutation,
 * no GROUP.md writes. Those are a later, permission-gated phase (#87 Phase 2 /
 * #90). The whole server is gated behind `config.sdk.octoTools` (default off).
 */

import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import {
  fetchBotGroups,
  getGroupInfo,
  getGroupMembers,
  searchSpaceMembers,
} from './octo/api.js';

/** MCP server name; tools surface to the model as `mcp__octo__<tool>`. */
export const OCTO_TOOL_SERVER_NAME = 'octo';

/** Wrap a JSON-serializable value as an MCP text result. */
function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Wrap an error as an MCP error text result (the model sees the reason, no throw). */
function errResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/**
 * Build the read-only Octo tool DEFINITIONS for a resolved single-bot config.
 * Exported separately from the server so tests can invoke each handler directly
 * (the MCP server keeps its tools in private internals).
 */
export function buildOctoTools(config: Config) {
  const apiUrl = config.apiUrl;
  const botToken = config.botToken;

  return [
    tool(
      'list_groups',
      'List the Octo groups this bot belongs to (group number, name). Read-only.',
      {},
      async () => {
        try {
          const groups = await fetchBotGroups({ apiUrl, botToken });
          return jsonResult(groups);
        } catch (err) {
          return errResult(err);
        }
      },
    ),
    tool(
      'group_info',
      'Get a single Octo group\'s info (name, notice, member count, etc.) by its group number. Read-only.',
      { groupNo: z.string().min(1).describe('The group number (groupNo) to look up.') },
      async (args) => {
        try {
          const info = await getGroupInfo({ apiUrl, botToken, groupNo: args.groupNo });
          return jsonResult(info);
        } catch (err) {
          return errResult(err);
        }
      },
    ),
    tool(
      'group_members',
      'List the members (uid, name) of an Octo group by its group number. Read-only.',
      { groupNo: z.string().min(1).describe('The group number (groupNo) whose members to list.') },
      async (args) => {
        try {
          const members = await getGroupMembers({ apiUrl, botToken, groupNo: args.groupNo });
          return jsonResult(members);
        } catch (err) {
          return errResult(err);
        }
      },
    ),
    tool(
      'search_members',
      'Search members in the bot\'s Space by a name keyword. Read-only.',
      {
        keyword: z.string().min(1).describe('Name keyword to search for.'),
        limit: z.number().int().positive().max(50).optional().describe('Max results (default server-side).'),
      },
      async (args) => {
        try {
          const results = await searchSpaceMembers({
            apiUrl,
            botToken,
            keyword: args.keyword,
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          });
          return jsonResult(results);
        } catch (err) {
          return errResult(err);
        }
      },
    ),
  ];
}

/**
 * Build the read-only Octo tool server for a resolved single-bot config.
 * Returns an MCP server config to drop into the SDK `mcpServers` option.
 */
export function createOctoToolServer(config: Config) {
  return createSdkMcpServer({
    name: OCTO_TOOL_SERVER_NAME,
    version: '1.0.0',
    tools: buildOctoTools(config),
  });
}

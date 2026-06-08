/**
 * In-chat slash commands (v0.3).
 *
 * Users can control their session without leaving the chat:
 *   /reset            — clear this session's conversation history
 *   /config           — show the effective per-session settings
 *   /help             — list available commands
 *
 * Commands are matched on the FIRST line of the cleaned message text (after the
 * router has stripped any leading @bot mention), so `@bot /reset` works in
 * groups. Matching is case-insensitive and tolerant of surrounding whitespace.
 *
 * A command is scoped to the sessionKey of the message. In a group the session
 * is shared per channel, so `/reset` clears the WHOLE group's conversation
 * history (every member shares one session), not just the caller's. In a DM it
 * clears that peer's history. Note: it does NOT clear long-term auto-memory.
 *
 * Note: commands are handled inside the router's processing callback, AFTER the
 * per-session rate limit is applied. A user who has exhausted their token bucket
 * therefore cannot run `/reset` or `/help` until it refills — control commands
 * are rate-limited like normal messages. This is intentional (a flooder should
 * not get a rate-limit bypass via slash commands); documented in the README.
 */

import type { Config } from './config.js';
import type { SessionStore } from './session-store.js';

/** Result of attempting to handle a command. */
export interface CommandResult {
  /** True when the text was a recognized command and was handled. */
  handled: boolean;
  /** Reply to send back to the user (only meaningful when handled). */
  reply?: string;
}

/** Not a command at all — let the normal agent pipeline take over. */
const NOT_A_COMMAND: CommandResult = { handled: false };

/**
 * Parse the command token from a message body. Returns the lowercased command
 * name (without the leading slash) and the trimmed argument string, or null
 * when the text does not start with a slash command.
 *
 * Only the first whitespace-delimited token on the first line is considered, so
 * a message that merely mentions "/reset" mid-sentence is NOT treated as a
 * command — it must lead.
 */
export function parseCommand(
  body: string,
): { name: string; args: string } | null {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
  // The command name must be followed by a TOKEN BOUNDARY — end-of-line or
  // whitespace — before any args. Without this, path/route-like text such as
  // `/reset/foo`, `/config.json`, or `/help.md` would be parsed as the bare
  // command and could trigger a destructive action (`/reset`). Requiring `\s+`
  // (or EOL) after the name means only a real command token matches; anything
  // glued to the name (`/foo.bar`, `/a/b`) is NOT a command and falls through
  // to the normal agent pipeline.
  const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/** Human-readable list of supported commands. */
const HELP_TEXT = [
  'Available commands:',
  '• `/reset` — clear the conversation history for this session (the whole group, in a group chat); does not clear long-term memory',
  '• `/config` — show the current session settings',
  '• `/help` — show this message',
].join('\n');

/**
 * Render the effective, non-sensitive per-session configuration. Deliberately
 * omits secrets (botToken, apiUrl host details beyond scheme) — this reply is
 * visible to any user who can message the bot.
 */
function renderConfig(config: Config): string {
  const tools =
    config.sdk.allowedTools === '*'
      ? '* (all SDK tools)'
      : config.sdk.allowedTools.join(', ');
  return [
    'Current settings:',
    `• model: ${config.sdk.model ?? '(SDK default)'}`,
    `• allowedTools: ${tools}`,
    `• permissionMode: ${config.sdk.permissionMode}`,
    `• rateLimit: ${config.rateLimit.maxPerMinute} req/min`,
    `• historyLimit: ${config.context.historyLimit} messages`,
  ].join('\n');
}

/**
 * Try to handle `body` as a slash command for the given session.
 *
 * Returns `{ handled: false }` when the text is not a command (caller proceeds
 * with the normal agent pipeline). When handled, returns the reply to send and
 * performs any side effect (e.g. clearing history) immediately.
 *
 * `messageSeq` is the seq of the command message itself; `/reset` records it as
 * a persisted barrier so cold-start group backfill cannot resurrect pre-reset
 * history on a later turn.
 */
export function handleCommand(
  body: string,
  sessionKey: string,
  store: SessionStore,
  config: Config,
  messageSeq?: number,
): CommandResult {
  const parsed = parseCommand(body);
  if (!parsed) return NOT_A_COMMAND;

  switch (parsed.name) {
    case 'reset': {
      // Scoped to THIS sessionKey. In a group the session is shared per channel,
      // so this clears the whole group's conversation history; in a DM it clears
      // that peer's. Long-term auto-memory (under memoryBase) is NOT cleared.
      store.deleteSession(sessionKey);
      // Persist a barrier at this message_seq so G4 cold-start backfill (which
      // refetches channel history when the local cache is empty) cannot
      // re-seed the history we just cleared — even across a process restart.
      if (messageSeq !== undefined) {
        store.setResetBarrier(sessionKey, messageSeq);
      }
      // v0.3 persistent sessions: also forget the SDK session id, otherwise the
      // next turn would `resume` it and bring the just-cleared conversation back.
      store.clearSdkSessionId(sessionKey);
      return { handled: true, reply: '✓ Conversation history cleared (long-term memory is kept).' };
    }
    case 'config': {
      return { handled: true, reply: renderConfig(config) };
    }
    case 'help': {
      return { handled: true, reply: HELP_TEXT };
    }
    default:
      // A leading-slash token we don't recognize. Report it rather than
      // silently forwarding to the agent, so typos are visible.
      return {
        handled: true,
        reply: `Unknown command: /${parsed.name}\n\n${HELP_TEXT}`,
      };
  }
}

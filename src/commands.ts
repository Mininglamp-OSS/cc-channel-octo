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
 * A command is scoped to the sessionKey of the message — in a group, `/reset`
 * only clears the calling member's own session (group history is per-user), not
 * the whole room.
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
  // Must start with a single slash followed by a letter (avoid matching paths
  // like "/etc/passwd" being read as a command — those start with a slash but
  // we still treat a leading-slash word as a command; the command set is
  // closed, so an unknown command is reported rather than silently run).
  const match = firstLine.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)\s*(.*)$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

/** Human-readable list of supported commands. */
const HELP_TEXT = [
  'Available commands:',
  '• `/reset` — clear this conversation’s history (starts fresh)',
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
 */
export function handleCommand(
  body: string,
  sessionKey: string,
  store: SessionStore,
  config: Config,
): CommandResult {
  const parsed = parseCommand(body);
  if (!parsed) return NOT_A_COMMAND;

  switch (parsed.name) {
    case 'reset': {
      // Scoped to THIS sessionKey only — in a group, clears the caller's own
      // per-user history, never the whole room.
      store.deleteSession(sessionKey);
      return { handled: true, reply: '✓ Conversation history cleared. Starting fresh.' };
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

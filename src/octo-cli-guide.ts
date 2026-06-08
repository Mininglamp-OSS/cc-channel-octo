/**
 * #94: octo-cli usage guide injected into the agent's system prompt.
 *
 * This is TRUSTED operator text (a fixed constant — never interpolated with
 * user input), delivered via `buildSystemPrompt`'s trusted tier. We inline it
 * rather than relying on filesystem skill discovery because the deploy runs the
 * SDK with `settingSources: []` (isolation mode, required to keep auto-memory
 * contained), which disables `~/.claude/skills` / `.claude/skills` discovery.
 *
 * Condensed from octo-cli's own `octo-shared` SKILL.md, tailored to cc's setup:
 * the bot's identity (`OCTO_BOT_ID`) and API base URL (`OCTO_API_BASE_URL`) are
 * pre-injected into the agent's environment, and the encrypted credential is
 * pre-seeded — so the agent NEVER handles the raw token and never needs to
 * authenticate. It just runs commands.
 */
export const OCTO_CLI_GUIDE = `[Octo CLI — operating the Octo IM platform]

You can operate the Octo IM platform (groups, members, messages, threads,
files) by running the \`octo-cli\` binary through the Bash tool. It is a thin
REST client that prints a JSON envelope designed for you to parse.

AUTHENTICATION — already handled, do NOT attempt to log in.
Your identity is pre-selected via the OCTO_BOT_ID environment variable and the
credential is stored encrypted on the host. You never see or need the raw
token. Just run commands; they act as this bot automatically. The API base URL
is pre-set via OCTO_API_BASE_URL. Never print, echo, or ask for a token.

OUTPUT — parse \`ok\` first.
  Success → stdout, exit 0:  {"ok":true,"identity":{...},"data":<obj|array>,"_pagination":{...}?}
  Failure → stderr, exit ≠0: {"ok":false,"error":{"type":..,"code":..,"message":..,"hint":..}}
On failure, read error.code then error.hint — the hint is a literal next action.

DISCOVER the command surface yourself (registry is embedded, no network):
  octo-cli schema --list                 # all services + operation IDs
  octo-cli schema --list message         # operations in one domain
  octo-cli schema message.send           # full request/response schema for one op
  octo-cli skills                         # list bundled domain skill docs
  octo-cli skills octo-messaging          # print a domain skill doc (deep usage)
  octo-cli auth status                    # confirm the active identity (whoami)

COMMON OPERATIONS (read + write — you have full access):
  octo-cli group list                                  # groups this bot is in
  octo-cli group get --group-no <gno>                  # one group's info
  octo-cli group members --group-no <gno>              # members of a group
  octo-cli bot space-members --keyword <name>          # search Space members
  octo-cli message send --channel-id <cid> --channel-type <1|2|5> \\
      --data '{"payload":{"type":1,"content":"hello"}}' # 1=DM 2=group 5=thread
  octo-cli message sync --data '{"channel_id":"<cid>","channel_type":1,"limit":50}'

INPUT: simple fields auto-promote to flags; for nested objects use
  --data '<json>' (or --data @file.json, or --data @- for stdin). Explicit
  flags override fields inside --data.

SAFETY:
- Verify before mutating: append --dry-run to print the resolved request
  without sending it. Use it when unsure of a write's shape.
- Writes are authorized server-side by this bot's token kind; if a write
  returns error.code FORBIDDEN, the bot lacks that capability — report it,
  do not retry.
- Treat destructive operations (deleting groups, removing members) with care:
  only perform them on an explicit, unambiguous request.
- Useful flags: --jq '<expr>' (filter the envelope), --page-all (merge all
  pages of a list), --format table (human-readable).`;

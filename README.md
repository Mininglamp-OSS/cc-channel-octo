<h1 align="center">cc-channel-octo</h1>

<p align="center">
  Bridge <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> to <a href="https://github.com/nicco-io/octo">Octo</a> IM — an independent Node.js gateway powered by the <a href="https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk">Claude Agent SDK</a>.
</p>

<p align="center">
  <a href="https://github.com/Mininglamp-OSS/cc-channel-octo/actions"><img src="https://github.com/Mininglamp-OSS/cc-channel-octo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/cc-channel-octo"><img src="https://img.shields.io/npm/v/cc-channel-octo" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"></a>
  <img src="https://img.shields.io/node/v/cc-channel-octo" alt="Node.js version">
</p>

---

Users talk to a bot in Octo (DM or group @mention). The bot sends messages to Claude Code via the Agent SDK, streams the response back in real time, and persists conversation history in SQLite — all as a single self-contained process.

## Features

- **Streaming output** — Real-time response delivery via Octo's stream API with 800 ms throttled flushes, typing indicators, and automatic fallback to plain messages.
- **Tool progress** *(opt-in)* — With `sdk.toolProgress` enabled, the bot posts brief `🔧 Running <tool>…` notices as the agent invokes tools, so users see activity during long tool-heavy turns (deduped + capped per turn).
- **Group chat awareness** — Responds only to @mentions. Injects recent group conversation as context so Claude understands the discussion.
- **Session persistence** — SQLite-backed conversation history (40-message sliding window) with automatic 7-day expiry.
- **In-chat commands** — `/reset` clears your own session's stored history (not the shared recent-group-context cache), `/config` shows the active settings, `/help` lists commands. Scoped per-user (even in groups); subject to the same per-session rate limit as normal messages.
- **Rate limiting** — Per-session token bucket (default 5 req/min) with debounced rejection notices.
- **Security by configuration** — `allowedTools` whitelist + per-session `cwdBase` isolation. No runtime permission prompts (headless mode).
- **Zero infrastructure** — Single process, single SQLite file, `npm start` and go.

## Quick Start

### Prerequisites

- Node.js ≥ 22
- An Octo bot token (`bf_*`)
- Claude Code CLI installed (`npm i -g @anthropic-ai/claude-code`)
- `ANTHROPIC_API_KEY` set in your environment

### Install & Run

```bash
git clone https://github.com/Mininglamp-OSS/cc-channel-octo.git
cd cc-channel-octo
npm install
npm run build
```

Create a config file:

```bash
cp config.example.json config.json
```

Edit `config.json` with your credentials:

```jsonc
{
  "botToken": "bf_YOUR_BOT_TOKEN",
  "apiUrl": "https://your-octo-instance.com",
  "cwdBase": "/path/to/isolated/sandbox-root"  // ⚠️ parent dir for per-session sandboxes — must NOT contain config.json or secrets
}
```

Start the gateway:

```bash
npm start
```

The bot is now online. Send it a DM or @mention it in a group.

### Environment Variables

Every config field can be overridden via environment variables (highest priority):

```bash
CC_OCTO_BOT_TOKEN=bf_xxx \
CC_OCTO_API_URL=https://octo.example.com \
CC_OCTO_CWDBASE=/home/deploy/sandbox-root \
npm start
```

## Configuration

Three-level priority: **environment variables** > **config.json** > **defaults**.

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `botToken` | `CC_OCTO_BOT_TOKEN` | *(required)* | Octo bot token (`bf_*`) |
| `apiUrl` | `CC_OCTO_API_URL` | *(required)* | Octo API base URL |
| `cwdBase` | `CC_OCTO_CWDBASE` | `process.cwd()` | Base directory for per-session sandboxes. Each session (DM peer, or individual group member) gets its own SHA-256 hex subdirectory under it, matching how conversation history is partitioned; subdirs idle >7d are auto-cleaned every 6h. Legacy `cwd` / `CC_OCTO_CWD` still accepted with a deprecation warning. |
| `dataDir` | `CC_OCTO_DATA_DIR` | `./data` | SQLite database directory (created with `0700` permissions) |
| `sdk.model` | `CC_OCTO_SDK_MODEL` | *(SDK default)* | Claude model override |
| `sdk.allowedTools` | `CC_OCTO_SDK_ALLOWED_TOOLS` | `"*"` | Either `"*"` (allow every tool the SDK exposes) or an explicit string array whitelist. Env accepts a value containing `*` (wildcard) or a CSV list. |
| `sdk.permissionMode` | `CC_OCTO_SDK_PERMISSION_MODE` | `bypassPermissions` | SDK permission mode |
| `sdk.maxTurns` | `CC_OCTO_SDK_MAX_TURNS` | *(SDK default)* | Max agentic turns per query |
| `sdk.systemPrompt` | `CC_OCTO_SDK_SYSTEM_PROMPT` | *(built-in)* | Custom system prompt |
| `sdk.settingSources` | `CC_OCTO_SDK_SETTING_SOURCES` | `user` | Comma-separated setting sources (e.g. `user,project`) |
| `sdk.toolProgress` | `CC_OCTO_SDK_TOOL_PROGRESS` | `false` | When true, post `🔧 Running <tool>…` notices as the agent invokes tools (deduped, capped per turn) |
| `sdk.anthropicBaseUrl` | `ANTHROPIC_BASE_URL` | *(unset)* | Override the upstream Claude API endpoint. See [Self-hosted gateway](#self-hosted-gateway) below. |
| `rateLimit.maxPerMinute` | `CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE` | `5` | Max requests per minute per session |
| `context.maxContextChars` | `CC_OCTO_CONTEXT_MAX_CHARS` | `6000` | Max characters of group context injected into prompts |
| `context.historyLimit` | `CC_OCTO_CONTEXT_HISTORY_LIMIT` | `40` | Max messages in session history window |
| `botBlocklist` | `CC_OCTO_BOT_BLOCKLIST` | `[]` | Comma-separated bot UIDs to ignore in DMs (prevents bot loops) |
| `mentionFreeGroups` | `CC_OCTO_MENTION_FREE_GROUPS` | `[]` | Comma-separated group channel IDs where the bot responds to every text message without requiring an `@bot` mention (G12). |

### Self-hosted gateway

If you proxy the Claude API through your own gateway (corporate egress, regional
endpoint, model router, etc.), set `sdk.anthropicBaseUrl` to the gateway origin.
The value is forwarded to the Claude Agent SDK subprocess as the standard
`ANTHROPIC_BASE_URL` environment variable (scoped to the subprocess — it does
not mutate the gateway's own environment), so any deployment that already speaks
the Anthropic protocol will Just Work — no code changes required.

Because this endpoint receives the Anthropic API key and all prompt/response
content, it is SSRF-validated at boot exactly like `apiUrl`: it must be `https://`
(or `http://localhost` / `http://127.0.0.1` for local development), and may not
resolve to a private/link-local address. An unsafe value fails fast at startup.

```jsonc
{
  "sdk": {
    "anthropicBaseUrl": "https://claude-gw.internal.example.com"
  }
}
```

Or via environment (highest priority, no `CC_OCTO_` prefix — uses the Anthropic
SDK standard variable name):

```bash
ANTHROPIC_BASE_URL=https://claude-gw.internal.example.com npm start
```

Leave the field unset to talk to Anthropic's public endpoint directly.

## Security Model

cc-channel-octo runs Claude Code in **headless automation mode**. There is no terminal for interactive permission prompts, so `bypassPermissions` is the default. Security relies on two mechanisms:

### 1. `allowedTools` Whitelist

The `allowedTools` field accepts either the wildcard `"*"` (allow every tool
the SDK exposes — the default) or an explicit string array whitelist. Reduce
the list to reduce risk:

| Profile | `allowedTools` | Risk Level |
|---------|---------------|------------|
| **Full** (default) | `"*"` | High — every SDK tool available |
| **Explicit full** | `["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"]` | High — same surface, pinned list |
| **No network** | `["Read", "Write", "Edit", "Bash", "Glob", "Grep"]` | Medium — no SSRF risk |
| **No shell** | `["Read", "Write", "Edit", "Glob", "Grep"]` | Medium — no arbitrary commands |
| **Read-only** | `["Read", "Glob", "Grep"]` | Low — code reading only |

### 2. `cwdBase` Isolation

**`cwdBase` is the parent directory under which each session gets its own
hashed sandbox.** A 16-hex SHA-256 subdirectory is derived from the same
per-session key used for conversation history, so isolation is **per user** —
including inside groups, where each member's sessionKey embeds their uid. One
user's Claude Code session cannot read or mutate another's working tree.
Subdirectories idle for more than 7 days (measured from the last inbound
message) are cleaned up automatically every 6 hours.

**Limitation — cwd is a starting directory, not a chroot.** With `Bash`/`Read`
in the tool set and `bypassPermissions`, the agent can still be instructed to
read absolute paths outside the sandbox (e.g. `/etc/passwd`, or the gateway's
own `config.json`). Per-session `cwdBase` partitions sessions from *each other*;
it does not confine a single session to its directory. For a hard boundary, run
the gateway as an unprivileged user in a container/VM and tighten `allowedTools`
(drop `Bash`). Treat `cwdBase` itself as untrusted ground: any user who can
message the bot can read files within their own session sandbox.

Do **NOT** put these in `cwdBase`:
- `config.json` (contains your bot token)
- Private keys, credentials, or `.env` files
- Sensitive configuration outside the project scope

```
# ✅ Good — isolated sandbox root, no secrets inside
"cwdBase": "/home/deploy/cc-octo-sandboxes"

# ❌ Bad — config.json sits in the same directory
"cwdBase": "."
```

### Built-in System Prompt

A default system prompt instructs Claude to treat input as untrusted and decline requests for sensitive file reads or credential exfiltration. This is a **soft constraint** (model-level guidance), not a security boundary. The `allowedTools` whitelist and per-session `cwdBase` isolation are the real security controls.

### Bot Loop Prevention

- The bot ignores its own messages (by `robot_id`).
- Configure `botBlocklist` with UIDs of other bots to prevent DM ping-pong loops.
- In group chats, bot messages are cached as context but do not trigger AI processing (unless explicitly @mentioned).

## Architecture

```
Octo User
 ↓  WuKongIM WebSocket (binary, AES-CBC encrypted)
Gateway ─── bot registration, token refresh, heartbeat, process lock
 ↓
SessionRouter ─── session key routing, mention gating, rate limiting
 ↓
AgentBridge ─── prompt construction → Claude Agent SDK query()
 ↓  AsyncIterable<string>
StreamRelay ─── 800ms throttled flush, typing heartbeat, message splitting
 ↓
Octo REST API
 ↓
Octo User
```

The gateway connects to Octo via the WuKongIM binary protocol (DH key exchange + AES-CBC encryption). Inbound messages are routed through the session router, which enforces @mention gating for groups and per-session rate limiting. The agent bridge constructs prompts from conversation history and group context, then calls the Claude Agent SDK. Responses stream back through the stream relay, which throttles output and handles Octo's stream API lifecycle.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## Development

```bash
# Install dependencies (sets up husky pre-commit hook via `prepare` script)
npm install

# Type-check
npm run type-check

# Lint (zero warnings enforced)
npm run lint

# Run tests
npm test

# Watch mode
npm run test:watch

# Coverage report (HTML + lcov in coverage/)
npm run test:coverage

# Build
npm run build

# Start (after build)
npm start
```

### Quality gates

This repo enforces three layers of automated checks:

1. **Pre-commit (`.husky/pre-commit`)** — runs `lint-staged` (ESLint on staged files with `--max-warnings 0`) and `tsc --noEmit`. Set up automatically by `npm install`.
2. **CI (`.github/workflows/ci.yml`)** — every PR runs `type-check`, `lint`, `test`, and `test:coverage` as separate jobs. PRs cannot merge if any job fails.
3. **Strict TypeScript** — `noUnusedLocals`, `noUnusedParameters`, and full `strict` mode are on. Dead code fails the build.

Coverage artifacts are uploaded per CI run (retained 14 days). No hard threshold yet — baselines are being established.

Reviewers must follow [`docs/REVIEW_CHECKLIST.md`](./docs/REVIEW_CHECKLIST.md)
on security-adjacent PRs. The 9-item checklist is distilled from Stage 6
review-process failures and codifies hard-won rules like "reproduction test
before APPROVED", "refresh reviews state before clicking APPROVED",
"enumerate canonical-equivalent forms for attacker-input validation", etc.

### Project Structure

```
src/
├── index.ts            # Entry point — orchestrates all modules
├── config.ts           # Three-level config loading (env > file > defaults)
├── gateway.ts          # WKSocket lifecycle, bot registration, token refresh
├── session-router.ts   # Session routing, mention gating, rate limiting
├── agent-bridge.ts     # Claude Agent SDK integration
├── session-store.ts    # SQLite session + message persistence
├── group-context.ts    # Group message cache, member mapping, mention resolution
├── stream-relay.ts     # Throttled streaming output + fallback
├── db-adapter.ts       # SQLite adapter interface (better-sqlite3)
└── octo/
    ├── socket.ts       # WuKongIM binary protocol (forked from openclaw-channel-octo)
    ├── api.ts          # Octo Bot REST API client
    └── types.ts        # Protocol type definitions
```

## Known Limitations (v0.2)

- **Per-session `cwdBase` isolation** — Each session (DM peer, or individual group member) gets its own SHA-256 hex sandbox under `cwdBase`, partitioned by the same key as conversation history; idle sandboxes (>7d) are auto-cleaned every 6h. Note: `cwdBase` separates sessions from each other but does not confine a session to its directory (absolute-path reads via Bash/Read remain possible) — see the Security Model section.
- **Stateless sessions** — Uses the v1 `query()` API. Workspace state (open files, command history) does not persist across messages. The v2 Session API is planned for v0.3.
- **Single bot** — One bot per process. Multi-bot support is planned for v0.3.

## Roadmap

| Version | Scope |
|---------|-------|
| **v0.1** | Text messaging, streaming, session persistence, rate limiting, security model |
| **v0.2** *(current)* | Media reception & sending (image/file/RichText), @mention, group context, per-session `cwdBase` isolation, self-hosted gateway, SSRF/prompt-injection hardening |
| **v0.3** | v2 Session API, multi-bot support |
| **v1.0** | GROUP.md/THREAD.md configuration, webhook mode |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, coding standards, and the PR process.

## License

[Apache-2.0](./LICENSE)

Copyright (c) 2026 Mininglamp-OSS

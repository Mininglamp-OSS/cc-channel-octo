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
- **Group chat awareness** — Responds only to @mentions. Injects recent group conversation as context so Claude understands the discussion.
- **Session persistence** — SQLite-backed conversation history (40-message sliding window) with automatic 7-day expiry.
- **Rate limiting** — Per-session token bucket (default 5 req/min) with debounced rejection notices.
- **Security by configuration** — `allowedTools` whitelist + `cwd` isolation. No runtime permission prompts (headless mode).
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
  "cwd": "/path/to/isolated/project"  // ⚠️ Must NOT contain config.json or secrets
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
CC_OCTO_CWD=/home/deploy/project \
npm start
```

## Configuration

Three-level priority: **environment variables** > **config.json** > **defaults**.

| Field | Env Var | Default | Description |
|-------|---------|---------|-------------|
| `botToken` | `CC_OCTO_BOT_TOKEN` | *(required)* | Octo bot token (`bf_*`) |
| `apiUrl` | `CC_OCTO_API_URL` | *(required)* | Octo API base URL |
| `cwd` | `CC_OCTO_CWD` | `process.cwd()` | Working directory for Claude Code |
| `dataDir` | `CC_OCTO_DATA_DIR` | `./data` | SQLite database directory (created with `0700` permissions) |
| `sdk.model` | `CC_OCTO_SDK_MODEL` | *(SDK default)* | Claude model override |
| `sdk.allowedTools` | `CC_OCTO_SDK_ALLOWED_TOOLS` | `Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch` | Comma-separated tool whitelist |
| `sdk.permissionMode` | `CC_OCTO_SDK_PERMISSION_MODE` | `bypassPermissions` | SDK permission mode |
| `sdk.maxTurns` | `CC_OCTO_SDK_MAX_TURNS` | *(SDK default)* | Max agentic turns per query |
| `sdk.systemPrompt` | `CC_OCTO_SDK_SYSTEM_PROMPT` | *(built-in)* | Custom system prompt |
| `sdk.settingSources` | `CC_OCTO_SDK_SETTING_SOURCES` | `user` | Comma-separated setting sources (e.g. `user,project`) |
| `rateLimit.maxPerMinute` | `CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE` | `5` | Max requests per minute per session |
| `context.maxContextChars` | `CC_OCTO_CONTEXT_MAX_CHARS` | `6000` | Max characters of group context injected into prompts |
| `context.historyLimit` | `CC_OCTO_CONTEXT_HISTORY_LIMIT` | `40` | Max messages in session history window |
| `botBlocklist` | `CC_OCTO_BOT_BLOCKLIST` | `[]` | Comma-separated bot UIDs to ignore in DMs (prevents bot loops) |
| `mentionFreeGroups` | `CC_OCTO_MENTION_FREE_GROUPS` | `[]` | Comma-separated group channel IDs where the bot responds to every text message without requiring an `@bot` mention (G12). |

## Security Model

cc-channel-octo runs Claude Code in **headless automation mode**. There is no terminal for interactive permission prompts, so `bypassPermissions` is the default. Security relies on two mechanisms:

### 1. `allowedTools` Whitelist

The `allowedTools` array is the primary security control. Claude Code can only use tools in this list. Reduce the list to reduce risk:

| Profile | `allowedTools` | Risk Level |
|---------|---------------|------------|
| **Full** (default) | `Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch` | High — full automation |
| **No network** | `Read, Write, Edit, Bash, Glob, Grep` | Medium — no SSRF risk |
| **No shell** | `Read, Write, Edit, Glob, Grep` | Medium — no arbitrary commands |
| **Read-only** | `Read, Glob, Grep` | Low — code reading only |

### 2. `cwd` Isolation

**`cwd` must point to an isolated working directory.** Any Octo user who can message the bot can instruct Claude Code to read files within `cwd`.

Do **NOT** put these in `cwd`:
- `config.json` (contains your bot token)
- Private keys, credentials, or `.env` files
- Sensitive configuration outside the project scope

```
# ✅ Good — isolated project directory
"cwd": "/home/deploy/my-project"

# ❌ Bad — config.json is in the same directory
"cwd": "."
```

### Built-in System Prompt

A default system prompt instructs Claude to treat input as untrusted and decline requests for sensitive file reads or credential exfiltration. This is a **soft constraint** (model-level guidance), not a security boundary. The `allowedTools` whitelist and `cwd` isolation are the real security controls.

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
on security-adjacent PRs. The 14-item checklist (§0 ground rules through
§14 rule-system self-reference) is distilled from Stage 6
review-process failures and codifies hard-won rules like "reproduction test
before APPROVED", "refresh reviews state before clicking APPROVED",
"enumerate canonical-equivalent forms for attacker-input validation",
"pin assertions at the strictest enforcement boundary", "new §N declares
trigger + revert-invariant + sunset", etc.

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

## Known Limitations (v0.1)

- **Text only** — Image, file, and voice messages are not processed (the bot replies with a notice).
- **Shared `cwd`** — All users share a single Claude Code working directory. Per-session isolation is planned for v0.2.
- **Stateless sessions** — Uses the v1 `query()` API. Workspace state (open files, command history) does not persist across messages. The v2 Session API is planned for v0.3.
- **Single bot** — One bot per process. Multi-bot support is planned for v0.3.

## Roadmap

| Version | Scope |
|---------|-------|
| **v0.1** *(current)* | Text messaging, streaming, session persistence, rate limiting, security model |
| **v0.2** | Media reception (image/file), `/reset` and `/config` commands, per-session `cwd` isolation |
| **v0.3** | v2 Session API, multi-bot support, tool progress display |
| **v1.0** | Media sending, GROUP.md/THREAD.md configuration, webhook mode |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, coding standards, and the PR process.

## License

[Apache-2.0](./LICENSE)

Copyright (c) 2026 Mininglamp-OSS

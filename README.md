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
- **Tool progress** *(opt-in)* — With `sdk.toolProgress` enabled, the bot posts brief `🔧 Running <tool>(<params>)…` notices as the agent invokes tools (params are a truncated one-liner), so users see activity during long tool-heavy turns (deduped + capped per turn).
- **Group chat awareness** — Responds only to @mentions. Injects recent group conversation as context so Claude understands the discussion.
- **Session persistence** — SQLite-backed conversation history (40-message sliding window) with automatic 7-day expiry.
- **In-chat commands** — `/reset` clears your own session's stored history (not the shared recent-group-context cache), `/config` shows the active settings, `/help` lists commands. Scoped per-user (even in groups); subject to the same per-session rate limit as normal messages.
- **Rate limiting** — Per-session token bucket (default 5 req/min) with debounced rejection notices.
- **Security by configuration** — `allowedTools` whitelist + per-session workspace isolation. No runtime permission prompts (headless mode).
- **Multi-bot** — Run several independent bots in one process via a `bots[]` config array; each gets its own token, data directory, and sandbox root (no shared history).
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

cc-channel-octo uses a fixed, bot-first directory layout under **`~/.cc-channel-octo/`**:

```
~/.cc-channel-octo/
├── config.json            ← GLOBAL: shared defaults + the list of bots (no token)
├── skills/                ← optional: skills shared by ALL bots (see Agent skills)
└── <botId>/               ← one self-contained subtree per bot ("default" for a single bot)
    ├── config.json        ← THIS bot: botToken (required) + per-bot overrides
    ├── SOUL.md            ← optional personality (overrides sdk.systemPrompt)
    ├── skills/            ← optional: skills for THIS bot (override same-named global)
    ├── data/              ← SQLite history
    ├── workspace/         ← per-session cwd sandboxes (auto-created)
    └── memory/            ← long-term auto-memory (auto-created)
```

The directory holding the global `config.json` is the **baseDir**; every bot's
`data`/`workspace`/`memory` are **derived** from `<baseDir>/<id>/…` and are not
configurable, so a bot can never escape its own subtree.

Create the two config files:

```bash
mkdir -p ~/.cc-channel-octo/default
cp config.example.json     ~/.cc-channel-octo/config.json        # global (shared + bots list)
cp config.bot.example.json ~/.cc-channel-octo/default/config.json # the bot (token + overrides)
chmod 600 ~/.cc-channel-octo/config.json ~/.cc-channel-octo/default/config.json
```

Global `~/.cc-channel-octo/config.json` (shared; **no token**):

```jsonc
{
  "apiUrl": "https://your-octo-instance.com",
  "bots": [{ "id": "default" }]
}
```

Per-bot `~/.cc-channel-octo/default/config.json`:

```jsonc
{
  "botToken": "bf_YOUR_BOT_TOKEN",
  "sdk": { "model": "vertexai/claude-opus-4-8" }
}
```

Start the gateway:

```bash
npm start
```

The bot is now online. Send it a DM or @mention it in a group.

## Configuration

All configuration comes from JSON files — there are **no environment-variable
overrides**. Two layers: a **global** `~/.cc-channel-octo/config.json` (shared
defaults + the `bots` list) and one **per-bot** `~/.cc-channel-octo/<id>/config.json`
(its token + overrides). Per-bot fields win over the global layer; per-bot
directories are derived from `baseDir` (see the tree above) and are not
configurable.

| Field | Default | Description |
|-------|---------|-------------|
| `botToken` | *(required, per-bot)* | Octo bot token (`bf_*`). Lives in `<baseDir>/<id>/config.json`, not the global file. |
| `apiUrl` | *(required)* | Octo API base URL (shared; a bot may override). |
| `bots` | `[{id:"default"}]` | Which bots to run; each `id` selects its subtree + per-bot config. |
| *(dirs)* | *(derived)* | `data`/`workspace`/`memory`/`skills` are always `<baseDir>/<id>/…` — not configurable. |
| `sdk.model` | *(SDK default)* | Claude model override |
| `sdk.allowedTools` | `"*"` | Either `"*"` (allow every tool the SDK exposes) or an explicit string array whitelist. |
| `sdk.permissionMode` | `bypassPermissions` | SDK permission mode |
| `sdk.maxTurns` | *(SDK default)* | Max agentic turns per query |
| `sdk.systemPrompt` | *(built-in)* | Custom system prompt (a `<baseDir>/<id>/SOUL.md` overrides this). |
| `sdk.toolProgress` | `false` | When true, post `🔧 Running <tool>(<params>)…` notices as the agent invokes tools (params truncated; deduped, capped per turn) |
| `sdk.persistentSession` | `false` | When true, persist agent workspace state across messages via the SDK v2 Session API (resume by stored session id). `/reset` clears it. |
| `sdk.settingSources` | `['project']` | Filesystem settings sources the SDK loads. Default `['project']` so it discovers skills symlinked into the session sandbox's `.claude/skills/` (see [Agent skills](#agent-skills)). Memory stays isolated regardless (inline auto-memory dir pin). Add `'user'` only to deliberately load the operator's real `~/.claude`. |
| `groupConfigDir` | *(unset)* | Directory of per-group instruction files (`<groupId>.md`). A match is injected into the system prompt as trusted custom instructions for that group. See [Per-group instructions](#per-group-instructions). |
| `sdk.anthropicBaseUrl` | *(unset)* | Override the upstream Claude API endpoint. See [Self-hosted gateway](#self-hosted-gateway) below. |
| `sdk.env` | *(unset)* | Extra environment variables (`{ "KEY": "value" }`) injected verbatim into the agent's tool subprocess. Per-bot. Use to give a bot's skills what their CLIs need — e.g. `{ "OCTO_BOT_ID": "<robotId>" }` so a multi-bot deploy's `octo-cli` selects the right stored profile. See [Agent skills](#agent-skills). |
| `sdk.skills` | *(SDK default)* | Which skills this bot enables: `'all'` or a `string[]` of skill names. Per-bot **selection** over the centrally-maintained skill library (maintain once, each bot picks its subset). Omit to use the SDK default. See [Agent skills](#agent-skills). |
| `sdk.cron` | `false` | When true, give the agent a `cron` tool set to register per-bot scheduled tasks (persisted to `<baseDir>/<id>/cron.json`, fired through the normal pipeline). Creation is **owner-gated**. See [Scheduled tasks](#scheduled-tasks). |
| `rateLimit.maxPerMinute` | `5` | Max requests per minute per session |
| `context.maxContextChars` | `6000` | Max characters of group context injected into prompts |
| `context.historyLimit` | `40` | Max messages in session history window |
| `botBlocklist` | `[]` | Bot UIDs to ignore in DMs (prevents bot loops) |
| `mentionFreeGroups` | `[]` | Group channel IDs where the bot responds to every text message without requiring an `@bot` mention (G12). |

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

Leave the field unset to talk to Anthropic's public endpoint directly.

### Per-group instructions

Give a specific group its own persona or rules without code changes: set
`groupConfigDir` to a directory you control, and drop a `<groupId>.md` file in
it (the group's channel id, e.g. `s12_345.md`). Its contents are injected into
that group's system prompt as a trusted, **unsanitized** `[Group instructions]`
block. Only groups use this; DMs key on the peer uid. The key is the channel id,
so all topics under one `CommunityTopic` channel id share the same file.

```jsonc
// ~/.cc-channel-octo/config.json
{ "groupConfigDir": "/home/deploy/cc-octo-groups" }
// /home/deploy/cc-octo-groups/s12_345.md:
//   Always answer in formal English and cite sources.
```

> ⚠️ **Security — this is a trusted, unsanitized prompt-injection sink.** Its
> safety depends entirely on the files being writable **only** by the operator.
> Putting `groupConfigDir` outside every bot's `workspace/` is required (the
> gateway refuses otherwise) but **not sufficient**: under the shipped defaults
> (`allowedTools: "*"` + `bypassPermissions`) the agent has `Bash`/`Write` and
> can write **absolute** paths outside its sandbox — the workspace is a starting
> dir, not a chroot (see [Security Model](#security-model)). A malicious user
> could then have the agent write `<groupConfigDir>/<otherGroup>.md` and inject
> persistent, trusted instructions into another group. So you **must**:
> - make `groupConfigDir` and its files **non-writable by the gateway process
>   user** (e.g. root-owned, mode `0755`/`0644`), and/or
> - harden the deployment (drop `Bash` from `allowedTools`, run unprivileged,
>   sandbox the filesystem).
>
> As defense-in-depth the gateway refuses to inject a group/world-writable file,
> but that is a backstop, not the guarantee. Files larger than 16 KiB are
> truncated; an unsafe group id (path separators, `..`) is ignored.

### Agent skills

cc supports external tooling generically through **Claude skills**. Drop a skill
into a `skills/` directory and the agent can use it — there is **no per-tool code
in cc**. A skill is a standard directory with a `SKILL.md` (plus optional
`references/` and `scripts/`); it teaches the agent how to drive some external
CLI (`octo-cli`, `gh`, anything on `PATH`).

**Two layers** (mirroring the config model):

| Location | Scope |
|----------|-------|
| `~/.cc-channel-octo/skills/<name>/` | shared by **all** bots |
| `~/.cc-channel-octo/<id>/skills/<name>/` | **one** bot (overrides a same-named global skill) |

cc symlinks both layers into each session sandbox's `.claude/skills/` on every
turn, and the SDK discovers them because `sdk.settingSources` defaults to
`['project']`. (Memory isolation is unaffected — the auto-memory directory is
pinned via inline settings, which the SDK ranks above any project-level value.)

**Installing a skill.** Copy or symlink any `SKILL.md` directory into a `skills/`
folder. For octo operations, octo-cli ships ready-made skills:

```bash
mkdir -p ~/.cc-channel-octo/skills
octo-cli skills --install ~/.cc-channel-octo/skills   # octo-shared, octo-messaging, …
```

**Per-bot skill selection.** The library is maintained once; each bot picks its
subset via `sdk.skills` in its per-bot config.json — `'all'`, or a list of skill
names:

```jsonc
// ~/.cc-channel-octo/issue-triage/config.json
{ "sdk": { "skills": ["octo-messaging", "github-issue-triage"] } }
```

Omit it for the SDK default. So a `triage` bot can enable the triage + messaging
skills while another bot enables only messaging — from the same shared library.

**Per-bot identity.** Each bot's persona/rules are independent:

- `<id>/SOUL.md` — persona (overrides `sdk.systemPrompt`).
- `<id>/CLAUDE.md` — behavior rules. Discovered because the `project` source
  walks up from the session sandbox to the bot subtree.
- `~/.cc-channel-octo/CLAUDE.md` (optional) — an all-bots baseline (the same
  upward walk reaches it).

> ⚠️ **CLAUDE.md upward-walk has no project boundary.** The walk continues past
> the bot subtree all the way up the filesystem — so a `CLAUDE.md` in the host
> HOME or any ancestor directory **leaks into every bot's context**. Keep the
> deploy machine's `$HOME` (and ancestors) free of `CLAUDE.md`; put bot rules in
> `<id>/CLAUDE.md` and shared rules in `~/.cc-channel-octo/CLAUDE.md`. (This is
> also why `settingSources` stays `['project']`, not `['user']` — `user` would
> additionally pull in the host's personal `~/.claude` config/skills.)

**Prerequisites are the operator's responsibility, out-of-band:** install the
CLI a skill needs (`npm i -g @mininglamp-oss/octo-cli`, etc.) and authenticate it
(`octo-cli auth login`, `gh auth login`). **cc never handles credentials** — the
agent only runs the already-authenticated CLI. Skills are operator-owned and
trusted (like `SOUL.md`/`GROUP.md`); since their contents are visible to the
model, **never put secrets in a skill file**.

**Multi-bot tool identity.** When several bots share one CLI whose credential
store keys by identity (e.g. `octo-cli`, which needs `--bot-id`/`OCTO_BOT_ID` to
pick among ≥2 stored profiles), give each bot its selector via `sdk.env` in its
per-bot config.json — e.g. `{ "sdk": { "env": { "OCTO_BOT_ID": "<robotId>" } } }`.
cc injects it into that bot's tool subprocess so the CLI acts as the right bot.

### Scheduled tasks

Enable `sdk.cron: true` to give the agent a `cron` tool set so it can schedule
work — the missing "non-IM trigger" that makes a bot more than purely reactive.

```jsonc
// ~/.cc-channel-octo/<id>/config.json
{ "sdk": { "cron": true } }
```

The agent calls:
- `cron_create(schedule, prompt, recurring?)` — `schedule` is a 5-field cron
  expression (`"0 9 * * 1-5"` = weekdays 9am) or a one-shot ISO datetime
  (`"2026-06-09T09:00:00Z"`). Cron fields use the **gateway's local timezone**
  (set `TZ` on the process); ISO datetimes are absolute instants.
- `cron_list` / `cron_delete(id)`.

Tasks persist to `<baseDir>/<id>/cron.json` and survive restarts. When a task is
due, the gateway scheduler re-runs its `prompt` **through the normal message
pipeline, bound to the chat that created it** — so the result posts back in that
same channel, exactly as if the prompt had arrived as a message.

> **Security.** The `cron_create`/`cron_delete` **owner check** (`registerBot.owner_uid`)
> stops the agent from *casually* registering a task for a non-owner — but it is
> **not a hard boundary**: under the default `bypassPermissions` + `allowedTools: "*"`
> the agent can `Write` `cron.json` directly. That's inherent to a full-tool bot
> (it can already run any command), so **only enable `sdk.cron` for bots you'd
> already trust with full tools** (your own DM, trusted-team rooms). For an
> untrusted-input bot, restrict `allowedTools` instead — a cron-specific lock
> would be false assurance. A fired task bypasses the group @mention gate
> (authenticated by a per-process nonce so a real inbound payload can't forge it)
> and is still rate-limited; it is itself offered the cron tools, so it can
> self-schedule.

### Multi-bot

To run several bots from one process, list them in the global config's `bots`
array. Each `id` is a slug (letters, digits, `.`, `_`, `-`) that names the bot's
subtree under `baseDir`; each bot's **token + overrides live in its own
`<baseDir>/<id>/config.json`** (the highest-priority layer):

Global `~/.cc-channel-octo/config.json`:

```jsonc
{
  "apiUrl": "https://your-octo-instance.com",
  "bots": [
    { "id": "support" },
    { "id": "ops", "model": "vertexai/claude-opus-4-8" }
  ]
}
```

Per-bot `~/.cc-channel-octo/support/config.json` and `~/.cc-channel-octo/ops/config.json`:

```jsonc
{ "botToken": "bf_AAA" }
```

Each bot runs a fully independent stack (gateway, router, store). Its
`data`/`workspace`/`memory` are derived as `<baseDir>/<id>/…`, so **bots never
share conversation history, working directories, or memory** — the isolation is
structural and not overridable. A bot may override shared fields (`apiUrl`,
`model`, `systemPrompt`, `botBlocklist`, mention lists)
in its inline `bots[]` entry or, with higher priority, its per-bot config.json.
A single bot is just one entry (conventionally `id: "default"`).

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

### 2. Workspace Isolation (derived `workspace/`)

**Each bot's `workspace/` (`<baseDir>/<botId>/workspace`) is the parent under
which each session gets its own hashed sandbox.** A 16-hex SHA-256 subdirectory
is derived from the same per-session key used for conversation history, so
isolation matches the session granularity: **per DM peer**, and **per group
channel** — a whole group shares one sandbox (all members work in the same tree,
by design; a group is a shared workspace). Different DM peers, and different
groups, cannot read or mutate each other's working trees, and different **bots**
are fully isolated by their separate subtrees. Subdirectories idle for more than
7 days (from the last inbound message) are cleaned up automatically every 6 hours.

**Limitation — cwd is a starting directory, not a chroot.** With `Bash`/`Read`
in the tool set and `bypassPermissions`, the agent can still be instructed to
read absolute paths outside the sandbox (e.g. `/etc/passwd`). Per-session
sandboxing partitions sessions from *each other*; it does not confine a single
session to its directory. For a hard boundary, run the gateway as an
unprivileged user in a container/VM and tighten `allowedTools` (drop `Bash`).

Because the layout is fixed under `~/.cc-channel-octo/`, the bot's own
`config.json` (with the token) lives in the bot subtree root, a **sibling** of
`workspace/` — never inside it. Keep other secrets out of the bot subtree too;
treat `workspace/` as untrusted ground that any user who can message the bot can
read within their own session sandbox.

### Built-in System Prompt

A default system prompt instructs Claude to treat input as untrusted and decline requests for sensitive file reads or credential exfiltration. This is a **soft constraint** (model-level guidance), not a security boundary. The `allowedTools` whitelist and per-session workspace isolation are the real security controls.

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

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document, and
[RUNTIME.md](./RUNTIME.md) for how cc provides an openclaw-style agent runtime on
top of the Claude Agent SDK (identity, memory, sessions, skills — and the gaps).

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

- **Per-session workspace isolation** — Each session gets its own SHA-256 hex sandbox under the bot's `workspace/` (`<baseDir>/<botId>/workspace`), partitioned by the same key as conversation history — **per DM peer** and **per group channel** (a whole group shares one sandbox by design). Idle sandboxes (>7d) are auto-cleaned every 6h. Note: it separates sessions from each other but does not confine a session to its directory (absolute-path reads via Bash/Read remain possible) — see the Security Model section.
- **Groups are a shared workspace** — All members of a group share one history, one sandbox, and one auto-memory store (the session key is the channel id). There is **no member-to-member isolation within a group**; DM sessions remain private per peer.
- **Auto-memory is not TTL-reclaimed** — Long-term memory lives at `<baseDir>/<botId>/memory` (a sibling of `workspace/`) and is never swept by the cwd janitor, so it persists across `/reset` and grows unbounded on long-lived deploys.
- **Stateless sessions by default** — Uses the v1 `query()` API; workspace state (open files, command history) does not persist across messages. Enable `sdk.persistentSession` to use the SDK v2 Session API, which resumes the prior agent session each turn so that state carries over.

## Roadmap

| Version | Scope |
|---------|-------|
| **v0.1** | Text messaging, streaming, session persistence, rate limiting, security model |
| **v0.2** *(released)* | Media reception & sending (image/file/RichText), @mention, group context, per-session `cwdBase` isolation, self-hosted gateway, SSRF/prompt-injection hardening |
| **v0.3** *(merged, unreleased)* | Slash commands, tool progress, multi-bot, v2 Session API |
| **v1.0** *(merged, unreleased)* | GROUP.md per-group instructions |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, coding standards, and the PR process.

## License

[Apache-2.0](./LICENSE)

Copyright (c) 2026 Mininglamp-OSS

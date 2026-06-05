# Architecture

This document describes the internal architecture of cc-channel-octo: a standalone Node.js gateway that bridges [Claude Code](https://claude.ai/code) (via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) to [Octo](https://github.com/nicco-io/octo) instant messaging.

## Design Goals

1. **Independent process.** No dependency on OpenClaw or any orchestration layer. One binary, one config file, `npm start`.
2. **Minimal surface area.** 12 source files, ~1200 lines. Every module has a single responsibility and a clear boundary.
3. **Secure by default.** Headless automation requires `bypassPermissions`, so security is enforced through tool whitelisting (`allowedTools`), working directory isolation (`cwd`), and setting source restriction (`settingSources`).
4. **Protocol fidelity.** The Octo layer implements the WuKongIM binary protocol directly — DH key exchange, AES-CBC encryption, binary framing — rather than depending on a high-level SDK that may lag behind protocol changes.

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     cc-channel-octo                         │
│                                                             │
│  ┌──────────┐   ┌────────────────┐   ┌──────────────────┐  │
│  │  config   │──▶│    gateway      │──▶│  session-router  │  │
│  └──────────┘   │  (WS lifecycle)  │   │  (routing +      │  │
│                 │                  │   │   concurrency +   │  │
│                 └────────┬─────────┘   │   rate limiting)  │  │
│                          │             └────────┬──────────┘  │
│                          │ BotMessage           │             │
│                          ▼                      ▼             │
│  ┌──────────────┐   ┌──────────┐   ┌──────────────────────┐ │
│  │ group-context │   │ session- │   │    agent-bridge      │ │
│  │ (member cache │   │  store   │   │  (Claude Agent SDK)  │ │
│  │  + context    │   │ (SQLite) │   └──────────┬───────────┘ │
│  │  window)      │   └──────────┘              │             │
│  └──────────────┘                    AsyncIterable<string>   │
│                                                │             │
│                                     ┌──────────▼───────────┐ │
│                                     │    stream-relay      │ │
│                                     │  (typing + throttle  │ │
│                                     │   + split + fallback)│ │
│                                     └──────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         ▲                                      │
         │ WuKongIM binary protocol             │ Octo REST API
         │ (WebSocket)                          │ (stream/send)
         ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      Octo Server                            │
└─────────────────────────────────────────────────────────────┘
```

## Module Reference

The system is organized into three layers and a shared protocol package.

### Layer 0 — Protocol (`src/octo/`)

Forked from [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) v1.0.13. The fork is intentional: cc-channel-octo will evolve independently (e.g. it does not need OBO, rich text, or COS upload), and the code volume is small enough that maintaining a shared package would cost more than it saves.

| File | Responsibility |
|---|---|
| `types.ts` | Octo Bot API types, channel/message enums, mention payloads |
| `api.ts` | REST API functions: register, send, typing, heartbeat, stream start/send/end, group members, user info, channel message sync |
| `socket.ts` | WuKongIM binary protocol over WebSocket: DH key exchange (curve25519), AES-CBC encryption, binary framing (variable-length encoding), CONNECT/CONNACK/RECV/RECVACK/PING/PONG, reconnect with exponential backoff + jitter |

**Protocol details.** The WuKongIM protocol uses a custom binary framing format (not protobuf). Each frame has a 1-byte header (packet type in upper nibble, flags in lower nibble) followed by a variable-length body size and the body. Encryption is AES-128-CBC with keys derived from a Diffie-Hellman exchange (curve25519) during CONNECT/CONNACK. The salt from CONNACK provides the IV. Message IDs are 64-bit integers transmitted as big-endian — the API layer uses `parseOctoJson` to convert 16+ digit numeric IDs to strings before `JSON.parse` to avoid JavaScript precision loss.

### Layer 1 — Infrastructure

| File | Responsibility |
|---|---|
| `config.ts` | Three-level config resolution: defaults → `config.json` → `CC_OCTO_*` environment variables. Validates required fields (`botToken`, `apiUrl`). Strips `_`-prefixed keys (comments). Strict integer parsing rejects hex, negative, floating-point, and NaN. |
| `db-adapter.ts` | Thin abstraction over `better-sqlite3`. WAL journal mode, foreign keys ON, 5s busy timeout. Interface designed for future migration to `node:sqlite` when it reaches GA. |
| `session-store.ts` | SQLite persistence for sessions and message history. 7-day expiry with cleanup on startup. Prepared statements for all queries. History retrieval returns chronological `[role]: content` pairs for prompt construction. |
| `gateway.ts` | Process lifecycle: PID lock file (stale detection via `kill(pid, 0)`), bot registration, WebSocket connection management, 30s API heartbeat with 3-failure reconnect trigger, 60s token refresh cooldown, graceful SIGINT/SIGTERM shutdown. |

### Layer 2 — Application

| File | Responsibility |
|---|---|
| `session-router.ts` | Message routing pipeline: self-message filter → bot blocklist → group mention gate (`uids` or `ais`, NOT `all`) → rate limiting (token bucket, per-session, debounced notification) → non-text rejection. **Critical design: `routeAndHandle` holds a per-session lock across both routing and handler execution** — this eliminates the TOCTOU gap between "should I process this?" and "processing it". |
| `group-context.ts` | Group chat context management: in-memory message window (100 messages per channel, budget-capped to `maxContextChars`), member name cache (SQLite-backed, hourly API refresh), bidirectional uid↔name mapping, `@name` mention resolution via regex. Context string is built BEFORE the current message is cached to avoid duplication. |
| `agent-bridge.ts` | Claude Agent SDK integration. Builds a structured prompt (`[Group context]` + `[Conversation history]` + `[Current message]`), calls `query()` with configured permissions/tools/model, yields text chunks as `AsyncIterable<string>`. Includes a hardcoded system prompt that instructs the agent to reject credential exfiltration attempts. **Knows nothing about Octo.** |
| `stream-relay.ts` | Streaming output delivery. Typing indicator heartbeat (5s). Stream API path: `start` → throttled `send` (800ms minimum interval, full accumulated text each flush) → `end`. Falls back to plain `sendMessage` with intelligent splitting (paragraph > newline > space > hard cut, 3500 char segments) when the stream API is unavailable. Mutex guard prevents timer flush and loop flush from racing. |
| `index.ts` | Entry point orchestrator. Wires all modules in sequence: config → adapter → store → cleanup → group-context → stream-relay → gateway → router → message handler. The `handleMessage` function coordinates the full pipeline under the router's session lock. |

## Data Flow

### DM Message (Happy Path)

```
1. Octo user sends text message
2. WuKongIM delivers encrypted RECV packet via WebSocket
3. socket.ts decrypts (AES-CBC) and parses → BotMessage
4. gateway filters self-messages, calls registered handler
5. session-router: acquires per-session lock → passes blocklist/rate-limit/text checks → calls handler
6. Inside handler (still under lock):
   a. session-store: getOrCreate session, build history prefix
   b. agent-bridge: buildPrompt (history + message) → query() → AsyncIterable<string>
   c. stream-relay: typing heartbeat + throttled stream flushes to Octo
   d. session-store: append user message + assistant response
7. Lock released → next queued message for this session proceeds
```

### Group Message

Same as DM, with two additions:

- **Mention gate** (step 5): message must contain bot's UID in `mention.uids` or have `mention.ais` set. `mention.all` (humans-only `@所有人`) does NOT trigger the bot.
- **Group context** (step 6a): `refreshMembers` (hourly), `buildContext` (recent messages within char budget), then cache current message AFTER context is built to prevent duplication. The prompt becomes `[Group context]` + `[Conversation history]` + `[Current message]`.

Non-mentioned group messages are still cached in `group-context` for future context windows but do not trigger agent invocation.

## Concurrency Model

```
Session A msg1 ──▶ ┌──────────┐
Session A msg2 ──▶ │ Lock "A" │ ──▶ serial (FIFO)
Session A msg3 ──▶ └──────────┘

Session B msg1 ──▶ ┌──────────┐
Session B msg2 ──▶ │ Lock "B" │ ──▶ serial (FIFO)
                   └──────────┘

A and B run in parallel. Messages within the same session are strictly serialized.
```

The lock is a promise chain per session key (`Map<string, Promise<void>>`). This is deliberately simple — no worker threads, no job queues. The bottleneck is the Claude Agent SDK call (seconds to minutes), not the lock mechanism.

Session keys: DM uses `from_uid`; group uses `channel_id:from_uid` (per-user-per-group isolation).

## Security Model

### Threat Model

The bot accepts messages from any Octo user who can reach it. Users can send arbitrary text that becomes a Claude Code prompt. The attack surface is: **any Octo user can instruct Claude Code to do anything the tool whitelist allows within the working directory**.

### Mitigations

| Layer | Mechanism | Default |
|---|---|---|
| **Tool whitelist** | `allowedTools` restricts which Claude Code tools are available | `Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch` |
| **Working directory isolation** | `cwd` must not contain secrets, credentials, or config.json | Operator responsibility |
| **System prompt** | Instructs agent to reject credential exfiltration, sensitive file reads, and arbitrary network requests | Hardcoded in `agent-bridge.ts` |
| **Setting sources** | `settingSources: ['user']` — excludes `project` to prevent malicious `.claude/settings.json` in the working directory from overriding security settings | Default |
| **Rate limiting** | Token bucket per session, configurable `maxPerMinute` | 5 req/min |
| **Bot blocklist** | Prevents bot-to-bot loops | Empty by default |
| **Process lock** | PID file prevents multiple instances competing for the same bot identity | `data/gateway.lock` |

### Permission Mode

`bypassPermissions` is the only viable mode for headless operation. Without a terminal to answer prompts, any other mode would cause the agent to hang indefinitely. This is an intentional design choice, not a workaround — security comes from the tool whitelist and cwd isolation, not from interactive permission prompts.

### Reducing Attack Surface

| Risk Level | `allowedTools` | Use Case |
|---|---|---|
| **Read-only** | `Read, Glob, Grep` | Code review, search, explanation |
| **No shell** | `Read, Write, Edit, Glob, Grep` | Safe file editing |
| **No network** | `Read, Write, Edit, Bash, Glob, Grep` | Full local automation |
| **Full** (default) | All 8 tools | Maximum automation capability |

## Persistence

All persistent state lives in a single SQLite database (`data/cc-octo.db`):

| Table | Purpose | Lifecycle |
|---|---|---|
| `sessions` | Session metadata (channel, timestamps) | 7-day TTL, cleaned on startup |
| `messages` | Conversation history (user + assistant turns) | Cascade-deleted with session |
| `group_members` | Cached group member uid↔name mappings | Refreshed hourly via API |

SQLite is configured with WAL journal mode for concurrent read performance and `foreign_keys = ON` for referential integrity. The `db-adapter.ts` abstraction keeps the door open for `node:sqlite` migration.

## Configuration Resolution

```
Hardcoded defaults
       ▼
config.json (file)     ← strips _-prefixed keys
       ▼
CC_OCTO_* env vars     ← highest priority
       ▼
Validation             ← botToken + apiUrl required
       ▼
Final Config object
```

All 14 config fields are overridable via environment variables. See [README.md](./README.md) for the full reference table.

## Streaming Output

The stream relay implements a two-tier delivery strategy:

**Primary: Stream API.** Uses Octo's `stream/start` → `stream/send` → `stream/end` endpoints. Each `send` transmits the full accumulated text (not incremental deltas), base64-encoded as a JSON payload. Flushes are throttled to ≥800ms intervals to avoid API flooding. A mutex guard (`isFlushing`) prevents concurrent flushes from a timer callback and the main iteration loop.

**Fallback: Plain messages.** When the stream API returns an error (e.g. older Octo servers), the relay switches to `sendMessage` with intelligent text splitting. Split priority: paragraph break (`\n\n`) > newline (`\n`) > space > hard cut. Maximum segment size: 3500 characters.

Both paths maintain a typing indicator heartbeat at 5-second intervals so the user sees activity during long agent runs.

## Error Handling

- **Agent errors:** Caught per-message, best-effort error reply sent to user, does not crash the process.
- **Stream API failures:** Automatic fallback to plain messages, no user-visible error.
- **WebSocket disconnects:** Exponential backoff reconnect (3s base, 60s max, ±25% jitter). Three consecutive rapid disconnects (<5s each) trigger token refresh instead of reconnect.
- **Heartbeat failures:** Three consecutive API heartbeat failures trigger reconnect via token refresh.
- **Token refresh:** 60-second cooldown prevents refresh storms. Re-registers bot and establishes new WebSocket connection.
- **Process lock:** Stale PID detection via `kill(pid, 0)`. Active PID causes startup abort.

## Relationship to openclaw-channel-octo

cc-channel-octo and [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo) share the same Octo protocol layer (forked at v1.0.13) but serve different use cases:

| | cc-channel-octo | openclaw-channel-octo |
|---|---|---|
| **Backend** | Claude Agent SDK (Claude Code) | OpenClaw gateway |
| **Deployment** | Standalone process | OpenClaw plugin |
| **Target user** | "Just Claude Code + Octo" | Full OpenClaw ecosystem |
| **Protocol layer** | Forked, stripped (no OBO/media/COS) | Full feature set |

The protocol fork is synchronized before each release: `diff` upstream, port security fixes, skip OpenClaw-specific features. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the synchronization procedure.

## Future Directions

- **Media support.** Image/file/voice message handling (v0.2).
- **Multi-bot.** Multiple bot instances in one process with shared SQLite.
- **Conversation branching.** `/reset`, `/context` commands for session management.
- **Webhook mode.** HTTP webhook receiver as alternative to WebSocket for serverless deployments.

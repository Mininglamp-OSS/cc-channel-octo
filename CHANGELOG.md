# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, minor releases may carry breaking changes.

## [Unreleased]

### Added

- **Multi-bot support** (v0.3) — run several independent bots in one process via
  a top-level `bots[]` config array. Each entry needs its own `botToken` + `id`,
  inherits all top-level fields, and may override `apiUrl`/`dataDir`/`cwdBase`/
  `model`/`systemPrompt`/blocklists. Each bot gets a fully independent stack
  (gateway + router + store); `dataDir` and `cwdBase` are namespaced by id by
  default so bots never share history or sandboxes. Bot ids are validated as
  conservative slugs (no path separators) to keep that namespacing safe.
  `resolveBotConfigs()` expands the config and fails fast on missing/duplicate
  tokens or duplicate/invalid ids. All bot ids are registered into every router
  so a mention-free group can't trigger bot-to-bot reply loops, and the
  cold-start backfill sentinel is keyed per bot. In multi-bot mode the
  orchestrator owns a single SIGINT/SIGTERM shutdown that drains all bots
  (gateways skip their own signal handlers via a new `handleSignals` option).
  Single-bot configs are unchanged.
- **Tool progress display** (v0.3, opt-in) — with `sdk.toolProgress`
  (`CC_OCTO_SDK_TOOL_PROGRESS=true`), the bot posts brief `🔧 Running <tool>…`
  notices as the agent invokes tools. `queryAgent` gained a non-breaking
  `onToolUse` callback (guarded so a throwing callback never breaks the stream);
  `index.ts` dedups consecutive repeats and caps notices per turn.
- **In-chat slash commands** (v0.3) — `/reset` clears the current session's
  history, `/config` shows the active non-sensitive settings, `/help` lists
  commands. Handled before the agent query, scoped per-user (even in groups), so
  a command never reaches the LLM or leaks into another member's group context.
  `/reset` records a persisted reset barrier (by `message_seq`) so group
  cold-start backfill cannot resurrect the cleared history, even across a
  process restart. Commands are subject to the normal per-session rate limit.

## [0.2.0] - 2026-06-07

The first feature release after the initial `0.1.0` tag. It adds the full
inbound/outbound media and group-chat capabilities, per-session working-directory
isolation, a self-hosted gateway endpoint, and a large batch of security
hardening across the SSRF, prompt-injection, and protocol-DoS surfaces.

### Added

- **Self-hosted gateway endpoint** — `sdk.anthropicBaseUrl` config field (and the
  standard `ANTHROPIC_BASE_URL` env var) to route the Claude Agent SDK through a
  proxy/regional endpoint. SSRF-validated at boot like `apiUrl`.
- **Per-session `cwd` isolation** — each session (DM peer, or individual group
  member) gets its own hashed sandbox under `cwdBase`, partitioned by the same
  key as conversation history; idle sandboxes (>7d) are reclaimed every 6h.
- **`allowedTools: "*"`** wildcard form to allow every SDK tool; the env var
  accepts a `*` token or a CSV whitelist.
- **Inbound message resolution** — image/file/RichText payload handling, text-file
  inlining (base64-wrapped, budgeted), and group history backfill from the Octo
  API on cold start (G1, G2, G4, G11, G22).
- **Outbound capabilities** — media, RichText, and `@mention` send (G24, G5, G6, G7).
- **Group chat features** — Space isolation, history segmentation, `streamOn`
  cache filter, reply/quote context, read receipts, mention-free groups, and
  `@botname` stripping (G3, G8–G13, G9, G10, G21).
- **Bot/identity controls** — bot-loop prevention, owner identity, per-user rate
  limiting, robot flags (G14, G18, G19, G20, G23).
- **Octo API surface** — `fetchBotGroups`, `getGroupInfo`, `searchSpaceMembers`
  (G15, G16, G17).
- **CI & repo gates** — GitHub Actions, husky pre-commit/commit-msg/pre-push,
  coverage, strict `tsc`, commitlint (W0).
- **Docs** — `ARCHITECTURE.md`, `CONTRIBUTING.md`, self-hosted-gateway and
  security-model sections in `README.md`.

### Changed

- **Default `allowedTools` flipped to `"*"`** (was a hard-coded 8-tool list). The
  surface is bounded by `permissionMode` + per-session `cwdBase` isolation; the
  old list also silently blocked SDK-internal tools.
- **`cwd` → `cwdBase`** as the canonical config field. Legacy `cwd` / `CC_OCTO_CWD`
  still accepted with a one-time deprecation warning.
- **`dataDir` created with `0700`** permissions, enforced via `chmod` regardless of
  umask or a pre-existing directory (previously used the umask default).
- Response truncation limit, heartbeat logging, and runtime version now read from
  `package.json` (Q31, Q32, Q36).

### Fixed

- **Protocol DoS / correctness (D1)** — socket temp-buffer cap, base64 cap, system
  prompt cap, SDK null guard.
- **RichText pipeline (C1)** — crash on array payloads, per-payload budgets, G4
  payload merge, rejection-cache guard, `O(n)` byte-safe truncation.
- **Media pipeline (C2)** — output + media defects (P0-1, P1-3..6), inline-image
  safety gate, data-URI MIME-param parsing, legacy `image/svg` MIME rejection.
- **Byte-safe truncation (S2)** — correct handling of N×4-byte UTF-8 boundaries
  (no stray U+FFFD).
- Shutdown resilience — drain in-flight handlers, explicit `store.close()` WAL
  checkpoint, `unhandledRejection` handler (Q6, Q7, Q8).
- Rate limiting — peek-then-consume with per-bucket debounce (G20); global
  per-minute limit (Q13).
- Heartbeat restored on token-refresh failure; WS listener cleanup; 30s default
  `postJson` timeout (Q2, Q30, Q33, Q35).
- **e2e tests now drive the real `handleMessage` pipeline** instead of a
  hand-copied replica, closing a coverage gap around the per-session cwd wiring.

### Security

- **SSRF defense (S1, S2, S4, S5, S6)** — shared `url-policy.ts`; reject
  `file://`/non-http(s) schemes, private/loopback/link-local/CGN IPs (incl.
  v4-mapped IPv6 hex), `https://` to private hosts; per-hop redirect re-validation
  with cross-host `Authorization` scoping; WHATWG-canonical path-traversal check
  for encoded dot-segments; `%2F` encoded-slash rejection. **(breaking)**
- **Prompt-injection defense** — structural role separation with a non-overridable
  security prefix (Q3, Q9); sanitize reply quotes and group context (S3); inlined
  file content wrapped in base64 with a total payload cap (S2). **(breaking)**
- Replace `Math.random` DH seed with `crypto.randomBytes`; fix spread-induced stack
  overflow (Q4, Q5).
- Message-length limit, sanitized credential/error logs, config-file permission
  warning (Q10, Q11, Q12).
- `anthropicBaseUrl` SSRF-validated at boot so a stray endpoint cannot exfiltrate
  the API key; forwarded via scoped subprocess env (no global `process.env`
  mutation, no cross-request leak).

## [0.1.0]

Initial tagged baseline: text messaging, streaming output, SQLite session
persistence, rate limiting, and the core security model.

[0.2.0]: https://github.com/Mininglamp-OSS/cc-channel-octo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Mininglamp-OSS/cc-channel-octo/releases/tag/v0.1.0

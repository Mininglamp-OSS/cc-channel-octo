# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the major version is `0`, minor releases may carry breaking changes.

## [Unreleased]

## [1.0.1] - 2026-06-10

The first npm-installable release. No runtime behavior change — packaging only.

### Added

- **Published to npm as `@mininglamp-oss/cc-channel-octo`** — install with
  `npm install -g @mininglamp-oss/cc-channel-octo` or run via
  `npx @mininglamp-oss/cc-channel-octo`. A new GitHub Actions workflow
  (`npm-publish.yml`) publishes on a released tag (and via manual dispatch),
  with OIDC build provenance; it refuses to publish unless the tag matches
  `package.json`.
- **`cc-channel-octo` CLI bin** — the package now exposes a `bin`, so a global
  install / `npx` starts the gateway directly (no clone + build needed).

### Fixed

- **Gateway auto-start when launched via the installed bin** — the main-module
  guard compared `import.meta.url` against `process.argv[1]` verbatim, but the
  installed bin is a symlink under `node_modules/.bin/`, so the paths never
  matched and `main()` never fired (the command exited silently). The guard now
  canonicalizes both sides with `realpath`.

### Changed

- **`package.json` packaging metadata** — scoped name, a `files` allowlist
  (so the compiled `dist/` is actually shipped despite being `.gitignore`d),
  `publishConfig` (public + provenance), `repository` / `bugs` / `homepage`,
  and a `prepublishOnly` build hook.

## [1.0.0] - 2026-06-10

First stable release. Consolidates everything merged since `0.2.0` — the v0.3
line (slash commands, tool progress, multi-bot, v2 Session API), the v1.0 line
(per-group `GROUP.md` instructions), scheduled tasks (cron), skill-as-data
external tooling, the frozen-system-prompt / SDK-session-owned-history rework,
and a large batch of security hardening. **Contains breaking changes** —
configuration is now JSON-only and the `sdk.persistentSession` flag was removed
(see Changed / Migration notes below).

### Added

- **Scheduled tasks (cron)** (#115) — set `sdk.cron: true` to give the agent a
  `cron` tool set (`cron_create` / `cron_list` / `cron_delete`). Tasks (5-field
  cron or one-shot ISO) persist to `<baseDir>/<id>/cron.json` and are fired by a
  resident per-bot gateway scheduler through the normal `handleMessage` pipeline,
  bound to the session that created them (reply posts back to that channel). Fills
  RUNTIME.md's scheduled-tasks gap. **Security:** creation/deletion is owner-gated
  (`registerBot.owner_uid`), server-enforced — a prompt-injected agent cannot
  register a malicious unattended task; defense-in-depth line added to the
  security prompt. Synthetic fires carry `payload._cronFire` + a per-process
  nonce (`cron-fire-marker.ts`) to bypass the group @mention gate without being
  forgeable from an inbound payload (rate limiting still applies). All cron.json
  writes go through an atomic `CronStore.update()` read-modify-write (no
  lost-update race). A fired task is offered the cron tools (can self-schedule) —
  intentional for self-management; enable only for trusted-context bots. New
  `src/cron-{evaluator,store,tool,scheduler}.ts` + `cron-fire-marker.ts`; no new
  dependency (self-contained cron evaluator).

- **`sdk.skills` per-bot skill selection** (#110) — a bot enables a subset of the
  centrally-maintained skill library via `sdk.skills: string[] | 'all'`
  (per-bot). Maintain skills once in `~/.cc-channel-octo/skills/`; each bot picks
  what it uses. Strengthens the multi-bot identity model alongside per-bot
  `SOUL.md` + `<id>/CLAUDE.md`. `settingSources` stays `['project']` (not
  `['user']`) to avoid coupling bots to the host's personal `~/.claude`. Note:
  CLAUDE.md's upward-walk has no project boundary — keep the host `$HOME` (and
  ancestors) free of `CLAUDE.md`; see README.

- **`sdk.env` config** (#107) — declare extra environment variables, injected
  verbatim into the agent's tool subprocess. Generic (cc doesn't interpret them)
  and per-bot. Primary use: give a multi-bot deploy's shared CLI its identity
  selector, e.g. `{ "sdk": { "env": { "OCTO_BOT_ID": "<robotId>" } } }` so each
  bot's `octo-cli` calls pick the right stored profile (a bare call errors "no
  bot selected" once ≥2 profiles exist).

- **Agent skills — generic external tooling** (#100) — external CLIs (octo-cli,
  gh, anything on `PATH`) are integrated as DATA, not code. Drop a standard Claude
  skill (`SKILL.md` + optional `references/`/`scripts/`) into
  `~/.cc-channel-octo/skills/` (all bots) or `~/.cc-channel-octo/<id>/skills/`
  (per-bot, overrides global on a name collision). cc symlinks both layers into
  each session sandbox's `.claude/skills/` per turn (`src/skill-linker.ts`), and
  the SDK discovers them via the new `sdk.settingSources` default `['project']`.
  **No CLI name appears in cc code** — adding a tool needs zero code change.
  cc handles NO credentials: the operator installs + authenticates the underlying
  CLI out-of-band (`octo-cli auth login`, `gh auth login`). Memory isolation is
  preserved despite the `project` source because the auto-memory directory is
  pinned via inline `settings.autoMemoryDirectory` (ranked above projectSettings;
  verified). New `src/skill-linker.ts`; `Config` gains derived `skillsDir` /
  `globalSkillsDir`. `sdk.settingSources` default flipped `[]` → `['project']`.

- **Per-group instructions** (v1.0, GROUP.md) — set `groupConfigDir`
  (`CC_OCTO_GROUP_CONFIG_DIR`) to a directory of `<groupId>.md` files; a matching
  file's contents are injected into that group's system prompt as a trusted
  `[Group instructions]` block, so a group can have its own persona/rules without
  code changes. Operator-controlled; id is filename-pinned to a safe slug (no
  traversal), content capped at 16 KiB, groups only. Boot-time check (re-run
  per-bot) rejects a `groupConfigDir` equal to or nested under the agent-writable
  `cwdBase`, using realpath canonicalization. Because the agent can still write
  absolute paths under default Bash/bypassPermissions, the block is a trusted
  prompt-injection sink whose safety requires OS-level file permissions + a
  hardened deployment — documented prominently, with a defense-in-depth refusal
  to inject a group/world-writable file. New `src/group-config.ts`.
- **Persistent sessions** (v0.3, opt-in) — with `sdk.persistentSession`
  (`CC_OCTO_SDK_PERSISTENT_SESSION=true`), agent workspace state persists across
  messages via the SDK v2 Session API. Each session's SDK session id is stored
  (new `sdk_sessions` table) and `resume`d on the next turn; on resume the
  history prefix is suppressed (the SDK session already holds it). `/reset`
  clears the stored session id so a cleared conversation is not resumed.
  `queryAgent` gained an `opts.resume` + `opts.onSessionId` channel (both
  guarded). Default off — the proven stateless v1 `query()` path is unchanged.
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

### Changed

- **Frozen system prompt + SDK-session-owned history** — the bot's
  `systemPrompt.append` now carries ONLY stable, operator-controlled content
  (security prefix + SOUL + group instructions). Per-turn-variable content —
  conversation history (B5) and group context (B4) — no longer sits inside the
  SDK's cached system block, so the prompt-caching prefix is byte-identical
  turn-to-turn and actually hits (previously every turn was a cache-write with zero
  reads, because the changing history/context lived inside the `cache_control`
  block). Follows Anthropic's own guidance ("keep the system prompt frozen; inject
  dynamic context in a user message"). **Conversation history is now owned by the
  SDK session:** cc always `resume`s the stored session id; only a session's FIRST
  turn (or a migration from existing SQLite history) injects prior history ONCE as
  a `[Prior conversation history]` block in the user message. **Group context** is
  injected as a delta — only messages new since a per-channel consumption cursor
  (`group_context_cursors`), not the whole window every turn. **`sdk.cron`-style
  flag removed:** `sdk.persistentSession` is gone — SDK sessions are always on (with
  the flag off and history out of the prompt, "off" would mean no memory at all).
  **Stale-resume recovery:** an expired/invalid session id (the SDK throws "No
  conversation found with session ID …") is caught, the bad id cleared, and the turn
  retried once without resume — re-injecting history from SQLite so a conversation is
  never silently lost. SQLite's role is now state/cursors/mappings + a durable record
  (migration & recovery substrate), not live prompt-history reconstruction.
  `buildSystemPrompt(customPrompt?, groupInstructions?)` and `queryAgent(userMessage,
  config, sessionCtx?, onToolUse?, opts?)` lost their history/context params.
  **Migration:** drop any `sdk.persistentSession` / `CC_OCTO_SDK_PERSISTENT_SESSION`
  from config — it's ignored now; existing SQLite history is injected once on each
  session's next turn, then carried by the SDK session.
- **Config is JSON-only — all environment-variable overrides removed** (#103).
  The entire `CC_OCTO_*` env surface and the `ANTHROPIC_BASE_URL` env read are
  gone; `applyEnv()` (and its `parseCsv`/`parseIntStrict` helpers) were deleted.
  Configuration now comes solely from the two-layer config.json (global +
  per-bot). `sdk.anthropicBaseUrl` remains a config.json field (still forwarded
  to the SDK subprocess as `ANTHROPIC_BASE_URL`). **Migration:** move any
  `CC_OCTO_*` / `ANTHROPIC_BASE_URL` values into `~/.cc-channel-octo/config.json`
  (or the per-bot file). Old env vars are now silently ignored.

### Removed

- **Dead Octo API functions** — removed `fetchBotGroups`, `getGroupInfo`,
  `searchSpaceMembers` (originally G15/G16/G17) and their `BotGroup` / `GroupInfo`
  / `SpaceMember` interfaces from `octo/api.ts`. They had **zero production callers**
  (only tests referenced them) — these read-only group/space queries are covered by
  the agent's octo-cli skill (`octo-cli group list` / `group get` / `bot space-members`).
  No runtime behavior change.
- **Dead media-upload pipeline + `cos-nodejs-sdk-v5`** — removed `media-upload.ts`
  (`uploadAndSendMedia` / `sendRichTextCombined` / `uploadFileToCOS`) and the
  `sendMediaMessage` / `sendRichTextMessage` API functions. This outbound media /
  rich-text pipeline had **zero production callers** (born-dead) — outbound media is
  handled by the agent's octo-cli skill (`octo-cli file upload` + `message send`)
  under the skill-as-data model. Dropping it removes the direct dependency on
  `cos-nodejs-sdk-v5`, which transitively pulled in the deprecated `request@2.88.2`
  chain and an old `fast-xml-parser` — clearing **11 Dependabot alerts** (2 critical,
  2 high incl. an unpatchable `request` SSRF) with no runtime behavior change.
  Inbound media (`media-inbound.ts`) and the startup CDN-host probe
  (`getUploadCredentials` in `index.ts`) are unaffected.
- **Webhook transport** (#105) — removed; the Octo server does not POST to the
  bot, so webhook mode was dead code. WebSocket is the only transport.
- **In-process Octo MCP tool server** (#87, never released) — the read-only
  `mcp__octo__*` tools (`list_groups`, `group_info`, `group_members`,
  `search_members`) and the `sdk.octoTools` toggle are removed in favor of the
  generic skill-based external tooling (#100), which covers any CLI's full
  surface without re-implementing operations in cc.
- **octo-cli-specific integration code** (#94, never released) — the brief
  `sdk.octoCli` toggle, the hand-maintained `OCTO_CLI_GUIDE`, the startup profile
  seeding, and the `OCTO_API_BASE_URL`/`OCTO_BOT_ID` env injection are removed.
  They baked one CLI into cc's core; #100 replaces them with the generic,
  zero-CLI-name skill loader.

### Fixed

- **Cron robustness — review follow-ups** (#115) — four operational-hardening
  fixes from the xhigh review: (1/5) cron fires now **bypass the rate limit**
  (like the @mention gate) so an operator-scheduled task isn't silently dropped
  when the owner's bucket is exhausted, and the scheduler **logs an async fire
  failure attributed to the specific task** (delivery errors were previously
  invisible); (2) a **startup warning** when `sdk.cron` is on but the bot has no
  `owner_uid` (the owner-gate would otherwise reject every `cron_create` with no
  hint why); (3) a synthetic cron fire's `message_seq=0` **no longer poisons the
  history-segmentation cursor** (`setLastBotReplySeq` is skipped for non-positive
  seq); (6) **strict ISO-8601 validation** for one-shot schedules
  (`parseOneShot`) so a lenient rollover like `2026-13-13T…` is rejected instead
  of silently firing at a shifted time.
- **Router drops non-conversation channel types** (#68) — found in live
  deployment: on connect the bot received a system message on `channel_type: 8`
  (`systemcmdonline`) and replied to it. `SessionRouter` now allowlists only DM /
  Group / CommunityTopic as repliable; any other (system/command) channel type is
  dropped before the agent is invoked.

### Security

- **WebSocket transport must be `wss://`** — the WuKongIM payload layer is
  AES-CBC without an auth tag, so transport integrity is the only tamper guarantee.
  `gateway.connect()` now refuses a plaintext `ws://` endpoint for any non-loopback
  host (`isAllowedWsUrl` in `url-policy.ts`); `ws://localhost` stays allowed for
  local dev / a co-located TLS-terminating proxy.
- **Binary protocol decoder bounds-checked** — `Decoder` (`octo/socket.ts`) now
  throws `RangeError` on any over-read (truncated packet, or a string length field
  exceeding the remaining buffer) instead of silently reading `undefined`
  (→ 0/NaN coercion → corrupt parses, wrong messageID/seq → ack mismatch). The
  packet-decode loop already catches and reconnects, so a malformed packet now
  fails cleanly.
- **Partial agent output no longer lost on stream error** — if the agent stream
  throws mid-delivery, `StreamRelay.deliver` now flushes the already-accumulated
  text to the channel before re-throwing, instead of dropping a real partial reply.
- **`@all` / `@所有人` broadcast detection tightened** — the trailing-boundary
  check used `[^\w]`, so `@all-members` / `@all.foo` wrongly triggered a
  broadcast-to-everyone. It now excludes name-continuation chars (`-`, `.`, CJK),
  while still matching a standalone token followed by space, CJK punctuation, or
  end-of-string.

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

[1.0.1]: https://github.com/Mininglamp-OSS/cc-channel-octo/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Mininglamp-OSS/cc-channel-octo/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/Mininglamp-OSS/cc-channel-octo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Mininglamp-OSS/cc-channel-octo/releases/tag/v0.1.0

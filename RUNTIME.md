# RUNTIME.md — cc-channel-octo as a Claude Agent SDK runtime

How cc-channel-octo provides an openclaw-style "agent runtime" by building on the
**Claude Agent SDK** rather than re-implementing one. This document states, per
capability, **what cc delegates to the SDK, what cc adds, and what is still a
gap** — so the boundary is explicit.

> Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (the L0–L7 layer design).
> ARCHITECTURE.md is *how the gateway is built*; this file is *what runtime
> capabilities the agent has and where they come from*.

## Design stance: thin gateway, SDK-as-runtime

openclaw is a **full, self-contained agent runtime** — it owns approvals,
heartbeat loops, restart coordination, state migrations, backups, etc. (a large
`src/infra/` surface). cc-channel-octo takes the opposite stance:

> **cc is a thin IM↔agent gateway. The agent *runtime* is the Claude Agent SDK.**

cc's job is the bridge — Octo protocol, session routing, concurrency / rate
limiting, streaming relay, inbound media — and to **configure** the SDK so the
agent behaves like a persistent digital worker. Almost every "runtime" feature
below is an SDK capability that cc *configures and scopes per bot*, not code cc
maintains.

This keeps cc small and lets it inherit SDK improvements (memory, compaction,
skills, sessions) for free — at the cost of living within the SDK's model (see
**Constraints**).

## Capability matrix

| Capability | Source | Status |
|---|---|---|
| Persona / identity (SOUL.md) | cc composes → SDK `systemPrompt` | ✅ Done |
| Behavior rules (CLAUDE.md) | SDK `project` settings discovery | ✅ Done |
| Long-term memory | SDK auto-memory | ✅ Done |
| Conversation continuity (sessions) | SDK session + `resume` (always-on) | ✅ Done (see #4) |
| Skills / external tools | SDK skills + Bash | ✅ Done |
| Per-bot isolation & identity | cc config + dirs | ✅ Done |
| Scheduled tasks | cc cron tool + gateway scheduler | ✅ Done |
| Autonomous / self-bootstrapping | — | ◑ Partial (agent schedules its own crons; no free-running loop) |

---

## 1. Persona & identity — SOUL.md ✅

Each bot's persona lives in `<baseDir>/<botId>/SOUL.md`. cc loads it
(`config.ts` `loadSoul`) and it **overrides** `sdk.systemPrompt`. The composed
system prompt — security prefix + SOUL + group instructions, all
operator-controlled and **frozen** (no per-turn history/context; see #4) — rides
in the SDK preset prompt's `append` (`agent-bridge.ts` `buildSystemPrompt`).
openclaw-style "give the bot a soul" — done, per bot.

## 2. Behavior rules — CLAUDE.md ✅ (with a documented caveat)

With `sdk.settingSources: ['project']` (the default), the SDK discovers CLAUDE.md
by walking **up** from the session sandbox cwd. So:

- `<baseDir>/<botId>/CLAUDE.md` — per-bot behavior rules.
- `<baseDir>/CLAUDE.md` — all-bots baseline (same upward walk reaches it).

> ⚠️ **The CLAUDE.md upward-walk has no project boundary** (verified: from a real
> sandbox it reaches `~/CLAUDE.md` and higher). Keep the deploy machine's
> `$HOME` and ancestor dirs free of `CLAUDE.md`. This is also why
> `settingSources` stays `['project']`, not `['user']` — `user` would pull in the
> host's personal `~/.claude` config/skills. See README "Agent skills".

## 3. Long-term memory ✅

cc enables the SDK's built-in **auto-memory**, pinned to a stable per-session dir
under `<baseDir>/<botId>/memory/` via inline `settings.autoMemoryDirectory`
(`agent-bridge.ts`; dir computed by `resolveMemoryDir`). The inline pin takes
precedence over any `projectSettings` value, so memory stays contained even with
`project` settings loaded (verified). Memory partitions match the session
(group = shared per channel, DM = per peer) and live **outside** `cwdBase` so the
7-day cwd TTL never reclaims it.

## 4. Conversation continuity — sessions ✅

The SDK persists each conversation as a session (`~/.claude/projects/.../*.jsonl`)
and continues it via `resume`. cc **always** resumes: it stores the SDK session id
per `sessionKey` and resumes it next turn. The SDK session is the **source of
truth** for conversation history.

**Frozen system prompt.** Per Anthropic's own guidance (found in the bundled
`claude` binary: *"keep the system prompt frozen; inject dynamic context in a user
message"*), cc's `systemPrompt.append` now carries ONLY stable, operator-controlled
content — security prefix + SOUL + group instructions. It no longer contains
`[Conversation history]` (B5) or `[Group context]` (B4), so the SDK's cached system
block is byte-identical turn-to-turn and the prompt-caching prefix actually hits.
(Previously the per-turn-variable history/context sat inside the cached block,
forcing a cache-write with zero reads every turn.)

**Where dynamic content goes now:**
- **History (B5):** lives in the SDK session. Only the FIRST turn of a session
  (no stored id) — or a migration from an existing SQLite deployment — injects the
  prior history ONCE as a `[Prior conversation history]` block prepended to the
  user message. After that, `resume` carries it.
- **Group context (B4):** injected into the user message as a delta — only the
  group messages NEW since the channel's consumption cursor
  (`group_context_cursors`), not the whole window every turn.

**Verified by spike (#2) — group chat over SDK session works:**
- Multi-speaker attribution survives: encode the speaker in the turn content
  (`[user Alice]: …`); the SDK persists it verbatim and resume replays it. A
  later turn correctly answered "who said what".
- `resume` continuity across speakers is fine; the session id is stable across turns.

→ **DM and group are NOT fundamentally different** at the session level; both use
SDK sessions (only the `sessionKey` granularity differs: DM = `spaceId:peer`,
group = `channel_id`).

**Stale-resume recovery.** If a stored session id is invalid/expired the SDK throws
`No conversation found with session ID: …` (verified by spike). `queryAgent` catches
this (only when it fails before any output), clears the bad id, and retries once
WITHOUT resume, re-injecting the history block from SQLite — so a turn never silently
loses the conversation.

**Role split (implemented):**
- **Conversation history → SDK session** (resume): the source of truth.
- **SQLite → state, cursors, mappings**: durable conversation record (migration +
  stale-resume recovery substrate), group consumption cursor, session-id maps,
  `/reset` control — NOT live prompt-history reconstruction.

## 5. Skills & external tools ✅

External capability is data, not code: bare `SKILL.md` dirs in a shared library
(`<baseDir>/skills/` + per-bot `<baseDir>/<id>/skills/`), symlinked into each
sandbox's `.claude/skills/` by `skill-linker.ts`, discovered via the `project`
source. A skill teaches the agent to drive any CLI on PATH (e.g. `octo-cli`,
`gh`) through the built-in **Bash** tool. **No tool name appears in cc code.**

- **Per-bot selection:** `sdk.skills: string[] | 'all'` (per-bot config) picks a
  subset of the centrally-maintained library — maintain once, each bot enables
  what it needs.
- **Per-bot tool identity:** `sdk.env` injects non-secret selectors (e.g.
  `OCTO_BOT_ID`) so a shared CLI acts as the right bot.
- **Credentials:** cc handles none at runtime — the operator installs +
  authenticates each CLI out-of-band (`octo-cli auth login`, `gh auth login`).

## 6. Per-bot isolation & identity ✅

One process can run N bots (`bots: [...]`). Each gets an independent subtree
`<baseDir>/<id>/{config.json, SOUL.md, CLAUDE.md, data, workspace, memory, skills}`,
its own token, and its own SDK session/memory/cwd partitions. Bots share nothing
stateful. Identity = SOUL.md + CLAUDE.md (per bot) + a shared baseline CLAUDE.md.

---

## Scheduled tasks ✅ & autonomy ◑

### 7. Scheduled tasks ✅ (#115)

Enable `sdk.cron` to give the agent a `cron` tool set (`cron_create` /
`cron_list` / `cron_delete`). The agent registers recurring (5-field cron) or
one-shot (ISO datetime) tasks; they persist to `<baseDir>/<botId>/cron.json` and
survive restarts. A resident per-bot **scheduler** (`cron-scheduler.ts`, ~30s
tick, `.unref()`) fires due tasks by synthesizing a `BotMessage` (the task's
prompt, marked `payload._cronFire`) through the **normal `handleMessage`
pipeline** — so a fired task runs exactly like an inbound message, bound to the
session that created it, and the reply goes back to that channel.

- **Security model — the owner-gate is "防误 not 防攻".** The `cron_create` /
  `cron_delete` owner check stops the agent from *casually* registering a task
  for a non-owner. It is **not** a hard security boundary, and `cron.json` is
  **not** an authenticity-checked execution source: under the default
  `permissionMode: bypassPermissions` + `allowedTools: "*"`, the agent already
  has `Write`/`Bash` and can write `<baseDir>/<id>/cron.json` directly, bypassing
  the tool gate entirely. This is inherent to a full-tool bot — in that mode the
  agent can already run any command, so cron adds no *new* capability an attacker
  who controls the agent didn't already have. **Therefore: only enable `sdk.cron`
  for bots you'd already trust with `bypassPermissions` + full tools** (your own
  DM, trusted-team rooms). For an untrusted-input bot, the right control is a
  restricted `allowedTools` (no arbitrary file write) — not a cron-specific lock,
  which would be false assurance. (Reviewed: the tool owner-gate + the prompt
  refusal line are defense-in-depth; the real boundary is the bot's tool set.)
- **Self-propagation (same envelope):** a cron fire is an owner-authorized turn
  with the full cron tools, so a scheduled task *can* create/delete tasks — what
  lets a bot manage its own schedule. Same trust envelope as above.
- **Mention-gate bypass:** synthetic cron messages set `payload._cronFire` so a
  group task fires without an @mention; rate limiting still applies. The marker
  is authenticated by a per-process secret nonce (`cron-fire-marker.ts`). Note
  the inbound decoder spreads the wire payload (`socket.ts` `...payloadObj`), so
  a real message *could* carry a `_cronFire` field — the nonce is what makes that
  forgery inert (it can only ever skip the @mention requirement anyway, never
  create a task; task creation is a separate in-process path).
- **Missed tasks:** if the bot was down across a task's window, it fires once on
  catch-up, then advances to the next future occurrence (no thundering herd).
- **Concurrency:** all cron.json mutations (tool create/delete + scheduler
  advance) go through a single atomic `CronStore.update()` read-modify-write, so
  concurrent turns / a scheduler tick overlapping a tool call can't lose tasks.

### 8. Self-bootstrapping ◑ (partial)

The agent now has *some* initiative: via the cron tool it can schedule its own
future runs (e.g. "remind me to check CI in an hour", or a recurring self-audit).
What's still missing for full autonomy is a **free-running loop** — a bot still
cannot act with no trigger at all; every action originates from either an inbound
message or a cron fire it (or the owner) registered. A true always-on autonomous
loop would build on #7.

---

## Summary

cc replicates the **identity + memory + skills + session + scheduled tasks** parts
of an openclaw-style runtime by configuring the Claude Agent SDK per bot — with
little runtime code of its own. The remaining gap is **full autonomy**: the agent
can schedule its own future runs (cron) but has no always-on free-running loop —
every action still originates from an inbound message or a registered cron fire.
The **session layer** is now SDK-session-as-truth: the system prompt is frozen
(cacheable), history lives in the SDK session (resumed every turn), and SQLite is
demoted to state/cursors/mappings + a durable record for migration & stale-resume
recovery. The deliberate trade for staying thin is living within the SDK's model —
notably **lossy compaction**: on a long conversation the SDK summarizes older turns
and *can drop early details, including a speaker's specific facts* (verified in the
#2 spike). Business-critical facts that must survive compaction belong in
auto-memory or SQLite, not only in the rolling session.

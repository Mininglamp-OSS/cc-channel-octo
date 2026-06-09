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
| Conversation continuity (sessions) | SDK session + `resume` | ◑ Partial (opt-in; see #2) |
| Skills / external tools | SDK skills + Bash | ✅ Done |
| Per-bot isolation & identity | cc config + dirs | ✅ Done |
| Scheduled / autonomous tasks | — | ❌ Gap |
| Self-bootstrapping | — | ❌ Gap |

---

## 1. Persona & identity — SOUL.md ✅

Each bot's persona lives in `<baseDir>/<botId>/SOUL.md`. cc loads it
(`config.ts` `loadSoul`) and it **overrides** `sdk.systemPrompt`. The composed
system prompt (security prefix + SOUL + group instructions + context/history)
rides in the SDK preset prompt's `append` (`agent-bridge.ts` `buildSystemPrompt`).
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

## 4. Conversation continuity — sessions ◑

The SDK persists each conversation as a session (`~/.claude/projects/.../*.jsonl`)
and continues it via `resume`. cc supports this through `persistentSession`
(opt-in) — it stores the SDK session id and `resume`s next turn.

**Today (default OFF):** cc rebuilds `[Conversation history]` from its own SQLite
`messages` table and injects it into the prompt each turn. This predates heavy
session use.

**Verified by spike (#2) — group chat over SDK session works:**
- Multi-speaker attribution survives: encode the speaker in the turn content
  (`[user Alice]: …`); the SDK persists it verbatim and resume replays it. A
  later turn correctly answered "who said what".
- `resume` continuity across speakers is fine; the session id is stable across
  turns (cc's `onSessionId` re-store is harmless but more than needed).

→ **DM and group are NOT fundamentally different** at the session level; both can
use SDK persistent sessions (only the `sessionKey` granularity differs:
DM = `spaceId:peer`, group = `channel_id`). The SQLite-history approach is
largely a pre-session legacy, not a group requirement.

**Intended role split (evolution direction):**
- **Conversation history → SDK session** (persistent + resume): the source of truth.
- **SQLite → state, cursors, mappings**: group background-message consumption
  offset, session-id maps, `/reset` control — *not* history reconstruction.

This is a future refactor, not yet implemented — tracked as the evolution from
the current opt-in `persistentSession` to session-as-default.

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

## Gaps vs a full openclaw runtime

### 7. Scheduled / autonomous tasks ❌

openclaw has heartbeat/scheduling infra; cc has **none** at the business level.
cc's only timers are mechanical (connection heartbeat, typing indicator, cwd
cleanup) — not "wake the agent at 9am to triage issues". A bot acts only when an
IM message arrives.

**How it could be added (SDK-native):** the SDK exposes cron/wakeup primitives
(scheduled prompts) and the agent can self-schedule. A future `cc` feature would
let a bot register scheduled prompts (per bot, in config or via a skill) that
enqueue a synthetic inbound turn at a cron time — reusing the existing message
pipeline. Not yet built.

### 8. Self-bootstrapping ❌

openclaw bots can take initiative / self-restart / evolve their own config. cc
bots are reactive. The pieces exist (the agent has Bash + memory + skills, so it
*can* modify files in its workspace), but cc has no loop that lets a bot act
without an inbound trigger. Depends on (7).

---

## Summary

cc replicates the **identity + memory + skills + (optional) session** parts of an
openclaw-style runtime by configuring the Claude Agent SDK per bot — with little
runtime code of its own. The **reactive-only** nature (no scheduled/autonomous
tasks, no self-bootstrapping) is the main capability gap, and the **session
layer** is mid-evolution (SQLite-history today → SDK-session-as-truth, with
SQLite demoted to state/cursors). The deliberate trade for staying thin is living
within the SDK's model — notably **lossy compaction**: on a long conversation the
SDK summarizes older turns and *can drop early details, including a speaker's
specific facts* (verified in the #2 spike). Business-critical facts that must
survive compaction belong in auto-memory or SQLite, not only in the rolling
session.

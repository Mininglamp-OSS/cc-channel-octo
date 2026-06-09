# CLAUDE.md — cc-channel-octo

## Project

cc-channel-octo: Independent Node.js gateway bridging Claude Code (Claude Agent SDK) to Octo IM.

## Tech Stack

- TypeScript (strict, ES2022, NodeNext modules)
- better-sqlite3 for persistence
- WuKongIM binary protocol (DH + AES-CBC) for Octo WebSocket
- Claude Agent SDK v1 query() API
- vitest for testing

## Commands

- `npm run build` — compile TypeScript
- `npm run type-check` — type check without emit
- `npm run lint` — ESLint
- `npm test` — run tests
- `npx vitest run src/__tests__/<file>.test.ts` — run a single test file
- `npm run dev` — tsc in watch mode
- `npm start` — start the gateway

## Code Style

- All code, comments, commit messages, PR descriptions in English
- Use `.js` extensions in TypeScript imports (NodeNext resolution)
- Prefer explicit error handling over silent catch
- No `any` unless unavoidable (warn level)

## Architecture

Layered design (L0–L7), see ARCHITECTURE.md. For how cc provides an
openclaw-style agent runtime on the Claude Agent SDK (identity/memory/sessions/
skills + gaps), see RUNTIME.md:
- L0: octo/ — WuKongIM binary protocol (forked from openclaw-channel-octo)
- L1: gateway.ts — WS lifecycle + token refresh
- L2: session-router.ts — routing + concurrency + rate limiting
- L3: agent-bridge.ts — Claude Agent SDK query()
- L4: stream-relay.ts — throttled streaming output
- L5: session-store.ts — better-sqlite3 persistence
- L6: group-context.ts — group chat context + mentions
- L7: config.ts — configuration loading

Cross-cutting: url-policy.ts (SSRF/URL validation), cwd-resolver.ts (per-session
cwd isolation), media-upload.ts / file-inline-wrap.ts (inbound media), db-adapter.ts.

## Testing

- Test files go in src/__tests__/
- Use vitest
- Tests must pass before commit

## Gotchas

- **Pre-commit hook scope** — `.husky/pre-commit` runs `lint-staged` (ESLint on
  staged `*.ts` only) + `npm run type-check`. Non-`.ts` files (README, *.json)
  bypass lint-staged; full `npm test` is deferred to CI, so run it locally
  before pushing.
- **Commit messages** — Conventional Commits (`feat:`, `fix:`, `chore(scope):`);
  enforced by a commitlint `commit-msg` hook on `main`.
- **Lint is zero-tolerance** — `eslint --max-warnings 0`, so an `any` (warn-level
  rule) fails the build despite being "just a warning".
- **Agent skills (generic external tooling)** — external CLIs (octo-cli, gh, …)
  are integrated as DATA, not code: operators drop standard Claude skills into
  `<baseDir>/skills/` (all bots) or `<baseDir>/<id>/skills/` (per-bot, overrides
  global). `src/skill-linker.ts` symlinks both layers into each session sandbox's
  `.claude/skills/` (per turn, in `agent-bridge.ts` after the cwd resolve), and
  the SDK discovers them because `sdk.settingSources` defaults to `['project']`.
  **No CLI name appears in cc code.** cc handles NO credentials — the operator
  installs + authenticates the CLI a skill needs out-of-band (`octo-cli auth
  login`, `gh auth login`). Memory stays isolated despite `project` source: the
  auto-memory dir is pinned via inline `settings.autoMemoryDirectory`, which the
  SDK ranks above any projectSettings value (verified). Skills are operator-owned
  + trusted; never put secrets in a skill file (their contents reach the model).
  Per-bot **selection** via `sdk.skills: string[] | 'all'` (config; library
  maintained once, each bot picks its subset). Per-bot **identity** via
  `<id>/SOUL.md` + `<id>/CLAUDE.md`. ⚠️ CLAUDE.md upward-walk has NO project
  boundary (verified: reaches `~/CLAUDE.md` and higher from a sandbox) — keep the
  deploy `$HOME`/ancestors free of `CLAUDE.md`; `~/.cc-channel-octo/CLAUDE.md` is
  the all-bots baseline. Do NOT switch `settingSources` to `['user']` (would pull
  in the host's personal `~/.claude`).

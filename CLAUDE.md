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

Layered design (L0–L7), see ARCHITECTURE.md:
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

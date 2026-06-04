# Contributing to cc-channel-octo

Thank you for your interest in contributing to cc-channel-octo! This document covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Protocol Layer Sync](#protocol-layer-sync)
- [Security](#security)

## Development Setup

### Prerequisites

- **Node.js** ≥ 22
- **npm** ≥ 10
- **Claude Code** installed and authenticated (`claude --version`)
- A valid Octo Bot token (`bf_*`)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/Mininglamp-OSS/cc-channel-octo.git
cd cc-channel-octo

# Install dependencies
npm install

# Copy and edit the configuration
cp config.example.json config.json
# Edit config.json with your bot token, API URL, and working directory

# Type-check
npm run type-check

# Run tests
npm test

# Build
npm run build

# Start the gateway
npm start
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Watch mode compilation |
| `npm run type-check` | Type-check without emitting |
| `npm run lint` | Run ESLint |
| `npm test` | Run tests (vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm start` | Start the gateway |

## Project Structure

```
cc-channel-octo/
├── src/
│   ├── index.ts              # Entry point — orchestrates all modules
│   ├── config.ts              # Configuration loading (env > file > defaults)
│   ├── gateway.ts             # WS lifecycle + bot registration + token refresh
│   ├── session-router.ts      # Routing + concurrency + mention gate + rate limiting
│   ├── agent-bridge.ts        # Claude Agent SDK query() invocation
│   ├── stream-relay.ts        # Throttled streaming output + typing heartbeat
│   ├── session-store.ts       # SQLite persistence (better-sqlite3)
│   ├── group-context.ts       # Group chat context cache + mention mapping
│   ├── db-adapter.ts          # Thin SQLite adapter interface
│   ├── __tests__/             # Test files
│   └── octo/                  # Octo protocol layer (forked)
│       ├── socket.ts          # WuKongIM binary protocol
│       ├── api.ts             # Octo Bot REST API
│       └── types.ts           # Protocol type definitions
├── ARCHITECTURE.md            # Detailed design document
├── CLAUDE.md                  # Claude Code project instructions
├── config.example.json        # Configuration template
└── package.json
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## Code Style

### Language

- All code, comments, commit messages, PR titles, and PR descriptions **must be in English**.
- Internal team chat may use any language; all repository artifacts are English-only.

### TypeScript

- **Strict mode** enabled — no implicit `any`, no unchecked index access.
- Use `.js` extensions in imports (NodeNext module resolution).
- Prefer explicit types over `any`. Use `unknown` + type guards when the shape is truly unknown.
- Prefer `const` over `let`. Never use `var`.
- Error handling: catch and log errors explicitly. **Never** use `.catch(() => {})` to swallow errors silently.

### Formatting

- ESLint with `@typescript-eslint` recommended rules.
- No unused variables (warning level).
- No explicit `any` (warning level).

## Testing

### Writing Tests

- Test files live in `src/__tests__/`.
- We use [vitest](https://vitest.dev/) as the test runner.
- Every PR that changes source code **must** include tests for the changed behavior.
- Mock external dependencies (Octo API, Claude Agent SDK) — don't make real network calls.
- For SQLite tests, use an in-memory database via `createAdapter(':memory:')`.

### What to Test

- **Unit tests**: individual functions and class methods in isolation.
- **Integration tests**: module interactions (e.g., SessionRouter + GroupContext).
- **Edge cases**: empty inputs, boundary values, error paths, concurrent access.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/__tests__/session-router.test.ts
```

### Pre-commit Checklist

Before every commit:

1. `npm run type-check` — zero errors
2. `npm test` — all tests pass
3. `npm run lint` — no errors (warnings acceptable)
4. `git add <specific files>` — never use `git add -A`
5. `git status` — verify only intended files are staged
6. `git branch --show-current` — confirm you're on the right branch

## Pull Request Process

1. **Branch naming**: `<author>/description` (e.g., `wangdachui/fix-rate-limiter`).
2. **One concern per PR**. Don't mix unrelated changes.
3. **Search before opening**. Check for existing open PRs that address the same issue.
4. **Rebase on main** before pushing: `git fetch origin main && git rebase origin/main`.
5. **PR description** must include:
   - What changed and why
   - Files modified
   - Test results (`npm run type-check && npm test` output)
   - Any breaking changes or migration notes
6. **All tests must pass**. PRs with failing tests will not be reviewed.
7. **Review states** — use them correctly:
   - `APPROVED` — code is ready to merge
   - `CHANGES_REQUESTED` — blocking issues that must be fixed
   - `COMMENTED` — discussion only, no approval or rejection
8. **Merge authority**: only the repository owner merges PRs unless explicitly delegated.

## Protocol Layer Sync

The `src/octo/` directory is forked from [openclaw-channel-octo](https://github.com/Mininglamp-OSS/openclaw-channel-octo). It is **not** a shared package — we maintain our own copy independently.

### Before Each Release

1. Diff our `src/octo/` against the upstream `openclaw-channel-octo` source:
   ```bash
   # Clone or update the upstream repo
   git clone --depth 1 https://github.com/Mininglamp-OSS/openclaw-channel-octo.git /tmp/oco-upstream

   # Compare
   diff -u /tmp/oco-upstream/src/socket.ts src/octo/socket.ts
   diff -u /tmp/oco-upstream/src/types.ts src/octo/types.ts
   diff -u /tmp/oco-upstream/src/api-fetch.ts src/octo/api.ts
   ```

2. Review upstream changes for:
   - **Security fixes** (AES-CBC padding, DH parameter validation, int64 parsing) — must be ported
   - **Protocol changes** (new packet types, field additions) — evaluate and port if relevant
   - **Bug fixes** (reconnect logic, framing edge cases) — port unless our fork already diverged

3. Document any ported changes in the commit message with a reference to the upstream commit.

### What NOT to Sync

- OpenClaw-specific features (COS upload, GROUP.md API, OBO, persona, thread binding)
- Dependencies we removed (axios, cos-nodejs-sdk-v5)
- LogSink interface (we use console directly)

## Security

### Reporting Vulnerabilities

If you discover a security vulnerability, **do not** open a public issue. Instead, email the maintainers directly or use GitHub's private vulnerability reporting feature.

### Security Considerations for Contributors

- **Never** hardcode secrets, tokens, or credentials in source code.
- `config.json` is in `.gitignore` for a reason — it contains the bot token.
- The `dataDir` directory (default `./data`) contains SQLite databases with chat history. Default permissions are `0700`.
- When modifying the protocol layer (`src/octo/`), pay special attention to cryptographic operations (AES-CBC, DH key exchange).
- The `bypassPermissions` + `allowedTools` security model is intentional for headless operation. Security depends on `cwd` isolation — see [ARCHITECTURE.md](./ARCHITECTURE.md) for details.

## License

By contributing to cc-channel-octo, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).

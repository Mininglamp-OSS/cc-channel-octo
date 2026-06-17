# CLI `version` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `version` / `--version` / `-v` command to the `cc-channel-octo` CLI that prints the package version (bare, e.g. `1.0.1`) read at runtime from `package.json`.

**Architecture:** Add a pure `readVersion()` helper to `src/cli.ts` that reads `version` from the package's own `package.json` (resolved relative to the module via `import.meta.url`, so it works both from `dist/cli.js` and `src/cli.ts`). Wire three new cases into the existing `run()` switch that print the bare version and return 0. The `USAGE` banner gains the version on its first line, assembled at print time (not as a module-load constant) so it stays a single source of truth.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Node `fs.readFileSync` + `URL`, vitest.

## Global Constraints

- All code, comments, commit messages in English (per repo CLAUDE.md).
- `.js` extension on TS relative imports (NodeNext) — N/A here (no new imports).
- No `any` (ESLint warn-level rule fails the `--max-warnings 0` build). Parse JSON as `unknown` and narrow.
- Conventional Commits (`feat:` / `fix:` / `chore(scope):`).
- Tests live in `src/__tests__/`, run with vitest; must pass before commit.
- Pure CLI-layer change only — do NOT touch any communication logic (octo/, gateway, agent-bridge, session-router).
- OSS repo (Mininglamp-OSS): no AI attribution / `Co-Authored-By` / review-tool names in commits or comments.

---

### Task 1: `readVersion()` helper

**Files:**
- Modify: `src/cli.ts` (add helper near the other pure helpers, after `resolveSupervisorPaths`)
- Test: `src/__tests__/cli.test.ts` (add a `describe('readVersion', …)` block + import)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function readVersion(): string` — returns the package version string, or `'unknown'` if `package.json` can't be read/parsed or has no string `version`.

**Why this resolves correctly:** both `src/cli.ts` and `dist/cli.js` are direct children of the package root, so `new URL('../package.json', import.meta.url)` points at the real `package.json` in test (vitest runs the TS source) and in production (compiled `dist`).

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/cli.test.ts`. First extend the import line:

```ts
import {
  parseArgs, isAlive, readPid, writePid, removePid, resolveSupervisorPaths, readVersion, run,
} from '../cli.js';
import { readFileSync } from 'node:fs';
```

Then append:

```ts
describe('readVersion', () => {
  it('returns the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });

  it('returns a non-empty semver-shaped string', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

(Note: the test file lives in `src/__tests__/`, one level deeper than `src/cli.ts`, hence `../../package.json` here vs `../package.json` inside `cli.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/cli.test.ts -t readVersion`
Expected: FAIL — `readVersion is not exported` / `is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, add `readFileSync` is already imported. Add after `resolveSupervisorPaths`:

```ts
/**
 * The package version, read at runtime from package.json (a sibling of the
 * package root, one level up from this module in both src/ and dist/). Returns
 * 'unknown' rather than throwing if the file is missing or malformed.
 */
export function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    const pkg: unknown = JSON.parse(raw);
    if (pkg && typeof pkg === 'object' && 'version' in pkg) {
      const v = (pkg as { version: unknown }).version;
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    /* fall through to 'unknown' */
  }
  return 'unknown';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/cli.test.ts -t readVersion`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/__tests__/cli.test.ts
git commit -m "feat(cli): add readVersion helper reading package.json at runtime"
```

---

### Task 2: Wire `version` / `--version` / `-v` into `run()` + version the USAGE banner

**Files:**
- Modify: `src/cli.ts` (`USAGE` constant → version line at print time; new switch cases)
- Test: `src/__tests__/cli.test.ts` (add a `describe('run version command', …)` block)

**Interfaces:**
- Consumes: `readVersion()` from Task 1; existing `run(argv: string[], baseDir?: string): Promise<number>`.
- Produces: no new exports. `run(['version'])`, `run(['--version'])`, `run(['-v'])` each print the bare version via `console.log` and resolve `0`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cli.test.ts`:

```ts
import { vi } from 'vitest';

describe('run version command', () => {
  it.each(['version', '--version', '-v'])('prints bare version and exits 0 for %s', async (arg) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await run([arg]);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledWith(readVersion());
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/cli.test.ts -t "run version command"`
Expected: FAIL — `-v` / `--version` hit the `default` branch (return 2, and `console.error` not `console.log`); `version` is `unknown command`.

- [ ] **Step 3: Write minimal implementation**

In `src/cli.ts`, change the `USAGE` banner first line to carry the version. Replace:

```ts
const USAGE = `cc-channel-octo — gateway process supervisor
```

with a function so the version is read once at print time:

```ts
function usage(): string {
  return `cc-channel-octo ${readVersion()} — gateway process supervisor
```

…and close it the same way the template literal already ends (keep the full body identical), then rename the trailing `` `; `` to `` `;\n} ``. Concretely, the block becomes:

```ts
function usage(): string {
  return `cc-channel-octo ${readVersion()} — gateway process supervisor

Usage:
  cc-channel-octo start [--foreground]   start the gateway in the background
  cc-channel-octo stop [--timeout=<s>]   gracefully stop (SIGTERM, then SIGKILL)
  cc-channel-octo restart                stop (if running) then start
  cc-channel-octo status                 show running state
  cc-channel-octo version                print the version

Paths (under ~/.cc-channel-octo):
  pid : cc-channel-octo.pid
  log : logs/gateway.log

POSIX only (macOS/Linux). On Windows, run under a service manager.`;
}
```

Then update the two `USAGE` references in `run()` to call `usage()`:

```ts
    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      return 0;
```

and in the `default` branch:

```ts
    default:
      console.error(`cc-channel-octo: unknown command '${cmd}'\n`);
      console.error(usage());
      return 2;
```

Add the version cases to the switch, before `help`:

```ts
    case 'version':
    case '--version':
    case '-v':
      console.log(readVersion());
      return 0;
```

- [ ] **Step 4: Run the full CLI test file**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: PASS (all existing + new). The existing `--help` test (if any references `USAGE` string) still passes because the body text is unchanged apart from the version prefix and the new `version` usage line.

- [ ] **Step 5: Type-check + lint**

Run: `npm run type-check && npm run lint`
Expected: no errors (no `any`, no unused symbols — confirm the old `USAGE` const has no lingering references).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/__tests__/cli.test.ts
git commit -m "feat(cli): add version command and show version in usage banner"
```

---

### Task 3: Manual smoke + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (add an entry under the unreleased/next section, matching existing style)

- [ ] **Step 1: Build and smoke-test the real binary**

```bash
npm run build
node dist/cli.js version
node dist/cli.js --version
node dist/cli.js -v
node dist/cli.js --help
```
Expected: first three print the bare version (e.g. `1.0.1`); `--help` shows the banner with `cc-channel-octo <version> —` on line 1 and the new `version` line.

- [ ] **Step 2: Add CHANGELOG entry**

Match the existing CHANGELOG format (read the top entries first). Add a bullet like:

```markdown
- `version` / `--version` / `-v` CLI command prints the package version.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note version command"
```

---

## Self-Review

- **Spec coverage:** bare-version output (Task 2 Step 1 asserts `console.log` called with bare `readVersion()`), three triggers `version`/`--version`/`-v` (Task 2 `it.each`), runtime read of package.json (Task 1), `'unknown'` fallback (Task 1 implementation), USAGE banner carries version (Task 2 Step 3). All covered.
- **Placeholder scan:** no TBD/TODO; all code shown in full.
- **Type consistency:** `readVersion(): string` defined Task 1, consumed Task 2 — signature matches. JSON parsed as `unknown` then narrowed (no `any`).
- **Path note:** `../package.json` inside `cli.ts` (src/ or dist/ → root); `../../package.json` inside the test file (src/__tests__/ → root). Both verified against the package layout.

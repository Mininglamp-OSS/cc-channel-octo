#!/usr/bin/env node
/**
 * cc-channel-octo CLI — a process supervisor for the gateway.
 *
 * The gateway itself (`index.ts`) only runs in the foreground. This thin
 * supervisor backgrounds it, tracks a single process-wide PID file, and stops
 * it gracefully (SIGTERM, then SIGKILL on timeout). It does NOT replace the
 * per-bot `gateway.lock` (which prevents two processes serving the same bot) —
 * the PID file lives at the baseDir root, a sibling of every bot subtree.
 *
 *   cc-channel-octo start [--foreground]
 *   cc-channel-octo stop  [--timeout=<seconds>]
 *   cc-channel-octo restart
 *   cc-channel-octo status
 *
 * POSIX only (macOS/Linux): stop relies on SIGTERM/SIGKILL. On Windows, run the
 * gateway under a service manager instead — Node has no SIGTERM semantics there.
 */

import { spawn } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG_PATH } from './config.js';
import { configure } from './configure.js';

export interface SupervisorPaths {
  baseDir: string;
  pidFile: string;
  logFile: string;
  indexEntry: string;
}

/**
 * Resolve the supervisor's fixed paths. baseDir defaults to the directory of
 * the global config (`~/.cc-channel-octo`); tests inject a temp dir. indexEntry
 * is the compiled gateway entrypoint, a sibling of this file.
 */
export function resolveSupervisorPaths(baseDir?: string): SupervisorPaths {
  const base = baseDir ?? dirname(DEFAULT_CONFIG_PATH);
  return {
    baseDir: base,
    pidFile: join(base, 'cc-channel-octo.pid'),
    logFile: join(base, 'logs', 'gateway.log'),
    indexEntry: fileURLToPath(new URL('./index.js', import.meta.url)),
  };
}

export interface ParsedArgs {
  cmd: string;
  foreground: boolean;
  timeoutMs: number;
  /** Positional version target for `upgrade` (e.g. `upgrade 1.2.3`); undefined → latest. */
  version?: string;
  /** `configure --gateway-url <url>`. */
  gatewayUrl?: string;
  /** `configure --api-key <key>`. */
  apiKey?: string;
}

/**
 * Extract a package version from raw package.json text. Returns 'unknown'
 * rather than throwing if the text is malformed or has no non-empty string
 * `version`. Pure (no I/O) so the fallback paths are unit-testable.
 */
export function parseVersion(raw: string): string {
  try {
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

/**
 * The package version, read at runtime from package.json — which lives at the
 * package root, one level up from this module in both src/ (src/cli.ts) and the
 * compiled output (dist/cli.js). Returns 'unknown' if the file can't be read.
 */
export function readVersion(): string {
  try {
    return parseVersion(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  } catch {
    return 'unknown';
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = '', ...rest] = argv;
  let foreground = false;
  let timeoutSec = 10;
  let version: string | undefined;
  let gatewayUrl: string | undefined;
  let apiKey: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--foreground' || a === '-f') {
      foreground = true;
    } else if (a.startsWith('--timeout=')) {
      const n = Number.parseInt(a.slice('--timeout='.length), 10);
      if (Number.isFinite(n) && n > 0) timeoutSec = n;
    } else if (a === '--gateway-url') {
      gatewayUrl = rest[++i];
    } else if (a.startsWith('--gateway-url=')) {
      gatewayUrl = a.slice('--gateway-url='.length);
    } else if (a === '--api-key') {
      apiKey = rest[++i];
    } else if (a.startsWith('--api-key=')) {
      apiKey = a.slice('--api-key='.length);
    } else if (!a.startsWith('-') && version === undefined) {
      version = a;
    }
  }
  return { cmd, foreground, timeoutMs: timeoutSec * 1000, version, gatewayUrl, apiKey };
}

/**
 * Liveness probe via signal 0. EPERM means the process exists but is owned by
 * another user — still "alive" for our purposes; ESRCH means it's gone.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function writePid(pidFile: string, pid: number): void {
  writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
}

export function removePid(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    /* already gone — fine */
  }
}

/** PID of the running gateway, or null. Cleans up a stale (dead-PID) file. */
function readRunningPid(paths: SupervisorPaths): number | null {
  const pid = readPid(paths.pidFile);
  if (pid !== null && isAlive(pid)) return pid;
  if (pid !== null) removePid(paths.pidFile);
  return null;
}

async function cmdStart(paths: SupervisorPaths, foreground: boolean): Promise<number> {
  if (foreground) {
    const child = spawn(process.execPath, [paths.indexEntry], {
      stdio: 'inherit',
      env: process.env,
    });
    return new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? 0));
    });
  }

  const running = readRunningPid(paths);
  if (running !== null) {
    console.log(`cc-channel-octo: already running (pid ${running})`);
    return 0;
  }

  mkdirSync(dirname(paths.logFile), { recursive: true });
  const fd = openSync(paths.logFile, 'a');
  const child = spawn(process.execPath, [paths.indexEntry], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  child.unref();

  if (child.pid === undefined) {
    console.error('cc-channel-octo: failed to spawn gateway');
    return 1;
  }
  writePid(paths.pidFile, child.pid);

  // Confirm it didn't exit immediately (bad config, taken lock, …).
  await sleep(400);
  if (!isAlive(child.pid)) {
    removePid(paths.pidFile);
    console.error(`cc-channel-octo: gateway exited on startup; see ${paths.logFile}`);
    return 1;
  }

  console.log(`cc-channel-octo: started (pid ${child.pid}), logs at ${paths.logFile}`);
  return 0;
}

async function cmdStop(paths: SupervisorPaths, timeoutMs: number): Promise<number> {
  const pid = readPid(paths.pidFile);
  if (pid === null || !isAlive(pid)) {
    removePid(paths.pidFile);
    console.log('cc-channel-octo: not running');
    return 0;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePid(paths.pidFile);
    console.log('cc-channel-octo: not running');
    return 0;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      removePid(paths.pidFile);
      console.log(`cc-channel-octo: stopped (pid ${pid})`);
      return 0;
    }
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* exited between the last check and now — fine */
  }
  removePid(paths.pidFile);
  console.log(`cc-channel-octo: force-killed (pid ${pid}) after ${timeoutMs / 1000}s`);
  return 0;
}

function cmdStatus(paths: SupervisorPaths): number {
  const pid = readRunningPid(paths);
  if (pid !== null) {
    console.log(`cc-channel-octo: running (pid ${pid}), logs at ${paths.logFile}`);
  } else {
    console.log('cc-channel-octo: stopped');
  }
  return 0;
}

/** npm package name installed globally for the gateway. */
const NPM_PKG = '@mininglamp-oss/cc-channel-octo';
/**
 * Semantic-version whitelist. The version reaches us from the daemon → fleet
 * upgrade order (an untrusted boundary) and is interpolated into an npm spec,
 * so reject anything outside `[0-9A-Za-z.-+]` to prevent argument/shell
 * injection even though we spawn npm without a shell.
 */
const VERSION_RE = /^[0-9A-Za-z.\-+]+$/;

/**
 * Build the `npm install -g <pkg>@<version>` argument vector. A blank/omitted
 * version installs `@latest`. Pure (no I/O) so the injection guard is unit
 * testable. Throws on an unsafe version string.
 */
export function buildUpgradeArgs(version?: string): string[] {
  const v = version && version.trim() ? version.trim() : 'latest';
  if (v !== 'latest' && !VERSION_RE.test(v)) {
    throw new Error(`unsafe version: ${v}`);
  }
  return ['install', '-g', `${NPM_PKG}@${v}`];
}

/**
 * Self-update: `npm install -g @mininglamp-oss/cc-channel-octo@<version>` then
 * restart the gateway so the new code is live. Invoked by the daemon to drive
 * a fleet upgrade order (mirrors openclaw's daemon-driven plugin install).
 */
async function cmdUpgrade(paths: SupervisorPaths, timeoutMs: number, version?: string): Promise<number> {
  let args: string[];
  try {
    args = buildUpgradeArgs(version);
  } catch (err) {
    console.error(`cc-channel-octo: ${(err as Error).message}`);
    return 2;
  }
  console.log(`cc-channel-octo: upgrading via npm ${args.join(' ')}`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn('npm', args, { stdio: 'inherit', env: process.env });
    child.on('error', (err) => {
      console.error(`cc-channel-octo: failed to spawn npm: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    console.error(`cc-channel-octo: npm install failed (exit ${code})`);
    return code;
  }
  // Restart so the freshly installed code is running.
  await cmdStop(paths, timeoutMs);
  return cmdStart(paths, false);
}

function usage(): string {
  return `cc-channel-octo ${readVersion()} — gateway process supervisor

Usage:
  cc-channel-octo start [--foreground]   start the gateway in the background
  cc-channel-octo stop [--timeout=<s>]   gracefully stop (SIGTERM, then SIGKILL)
  cc-channel-octo restart                stop (if running) then start
  cc-channel-octo status                 show running state
  cc-channel-octo upgrade [<version>]    npm install -g the gateway (default latest) then restart
  cc-channel-octo configure --gateway-url <url> [--api-key <key>]   write LLM gateway + key to config (or set CC_OCTO_CONFIGURE_API_KEY)
  cc-channel-octo version                print the version

Paths (under ~/.cc-channel-octo):
  pid : cc-channel-octo.pid
  log : logs/gateway.log

POSIX only (macOS/Linux). On Windows, run under a service manager.`;
}

export async function run(argv: string[], baseDir?: string): Promise<number> {
  const { cmd, foreground, timeoutMs, version, gatewayUrl, apiKey } = parseArgs(argv);
  const paths = resolveSupervisorPaths(baseDir);
  switch (cmd) {
    case 'start':
      return cmdStart(paths, foreground);
    case 'stop':
      return cmdStop(paths, timeoutMs);
    case 'restart':
      await cmdStop(paths, timeoutMs);
      return cmdStart(paths, false);
    case 'status':
      return cmdStatus(paths);
    case 'upgrade':
      return cmdUpgrade(paths, timeoutMs, version);
    case 'configure': {
      const resolvedApiKey = apiKey ?? process.env.CC_OCTO_CONFIGURE_API_KEY ?? '';
      const configPath = baseDir ? join(baseDir, 'config.json') : undefined;
      try {
        configure(gatewayUrl ?? '', resolvedApiKey, configPath);
        console.log('cc-channel-octo: configured gateway + api key');
        return 0;
      } catch (err) {
        console.error(`cc-channel-octo: ${(err as Error).message}`);
        return 2;
      }
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(readVersion());
      return 0;
    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      return 0;
    case '':
      // Backward compat: bare `cc-channel-octo` (e.g. `npx cc-channel-octo`)
      // runs the gateway in the foreground, matching the pre-supervisor bin
      // (`dist/index.js`) behavior documented in README/CHANGELOG. Daemon-style
      // process management is opt-in via the `start`/`stop`/`restart`/`status`
      // subcommands.
      return cmdStart(paths, true);
    default:
      console.error(`cc-channel-octo: unknown command '${cmd}'\n`);
      console.error(usage());
      return 2;
  }
}

// Run only when invoked as a script (production / linked bin), not when
// imported (tests). When called via the `bin` symlink, Node resolves
// import.meta.url to the real file but leaves process.argv[1] as the symlink
// path — so resolve argv[1] to its realpath before comparing, or the linked
// command would silently no-op.
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(realpathSync(entrypoint)).href) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('cc-channel-octo:', String(err));
      process.exit(1);
    });
}

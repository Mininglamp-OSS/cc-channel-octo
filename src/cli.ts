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
import { openSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_CONFIG_PATH } from './config.js';

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
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = '', ...rest] = argv;
  let foreground = false;
  let timeoutSec = 10;
  for (const a of rest) {
    if (a === '--foreground' || a === '-f') {
      foreground = true;
    } else if (a.startsWith('--timeout=')) {
      const n = Number.parseInt(a.slice('--timeout='.length), 10);
      if (Number.isFinite(n) && n > 0) timeoutSec = n;
    }
  }
  return { cmd, foreground, timeoutMs: timeoutSec * 1000 };
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

const USAGE = `cc-channel-octo — gateway process supervisor

Usage:
  cc-channel-octo start [--foreground]   start the gateway in the background
  cc-channel-octo stop [--timeout=<s>]   gracefully stop (SIGTERM, then SIGKILL)
  cc-channel-octo restart                stop (if running) then start
  cc-channel-octo status                 show running state

Paths (under ~/.cc-channel-octo):
  pid : cc-channel-octo.pid
  log : logs/gateway.log

POSIX only (macOS/Linux). On Windows, run under a service manager.`;

export async function run(argv: string[], baseDir?: string): Promise<number> {
  const { cmd, foreground, timeoutMs } = parseArgs(argv);
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
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    case '':
      console.error(USAGE);
      return 2;
    default:
      console.error(`cc-channel-octo: unknown command '${cmd}'\n`);
      console.error(USAGE);
      return 2;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('cc-channel-octo:', String(err));
      process.exit(1);
    });
}

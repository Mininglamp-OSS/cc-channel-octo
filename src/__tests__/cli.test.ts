/**
 * cc CLI supervisor — unit tests for the pure helpers.
 *
 * Covers arg parsing, PID-file round-tripping, liveness probing, and path
 * resolution. The spawning commands (start/stop/restart) are intentionally not
 * exercised here — they fork a real process and belong in an integration test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs, isAlive, readPid, writePid, removePid, resolveSupervisorPaths,
  readVersion, parseVersion, run,
} from '../cli.js';

describe('parseArgs', () => {
  it('defaults: no flags', () => {
    expect(parseArgs(['start'])).toEqual({ cmd: 'start', foreground: false, timeoutMs: 10_000 });
  });

  it('empty argv yields empty cmd', () => {
    expect(parseArgs([])).toEqual({ cmd: '', foreground: false, timeoutMs: 10_000 });
  });

  it('--foreground and -f both set foreground', () => {
    expect(parseArgs(['start', '--foreground']).foreground).toBe(true);
    expect(parseArgs(['start', '-f']).foreground).toBe(true);
  });

  it('--timeout=<n> overrides the stop timeout (seconds → ms)', () => {
    expect(parseArgs(['stop', '--timeout=30']).timeoutMs).toBe(30_000);
  });

  it('ignores a non-positive or non-numeric timeout', () => {
    expect(parseArgs(['stop', '--timeout=0']).timeoutMs).toBe(10_000);
    expect(parseArgs(['stop', '--timeout=abc']).timeoutMs).toBe(10_000);
  });
});

describe('isAlive', () => {
  it('returns true for the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('returns false for an unused PID', () => {
    // 2^31-1 is effectively never a live PID.
    expect(isAlive(2_147_483_647)).toBe(false);
  });

  it('returns false for invalid PIDs', () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(1.5)).toBe(false);
  });
});

describe('PID file helpers', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cli-'));
    pidFile = join(dir, 'cc-channel-octo.pid');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writePid → readPid round-trips', () => {
    writePid(pidFile, 12345);
    expect(readPid(pidFile)).toBe(12345);
  });

  it('readPid returns null when the file is missing', () => {
    expect(readPid(pidFile)).toBeNull();
  });

  it('readPid returns null for garbage content', () => {
    writeFileSync(pidFile, 'not-a-pid\n');
    expect(readPid(pidFile)).toBeNull();
  });

  it('removePid deletes the file and is a no-op when absent', () => {
    writePid(pidFile, 999);
    removePid(pidFile);
    expect(existsSync(pidFile)).toBe(false);
    expect(() => removePid(pidFile)).not.toThrow();
  });
});

describe('resolveSupervisorPaths', () => {
  it('derives pid/log under an injected baseDir', () => {
    const p = resolveSupervisorPaths('/tmp/base');
    expect(p.baseDir).toBe('/tmp/base');
    expect(p.pidFile).toBe('/tmp/base/cc-channel-octo.pid');
    expect(p.logFile).toBe('/tmp/base/logs/gateway.log');
    expect(p.indexEntry).toMatch(/index\.js$/);
  });

  it('defaults baseDir to the global config directory', () => {
    const p = resolveSupervisorPaths();
    expect(p.pidFile).toMatch(/\.cc-channel-octo\/cc-channel-octo\.pid$/);
  });
});

describe('parseVersion', () => {
  it('extracts a string version', () => {
    expect(parseVersion('{"version":"1.2.3"}')).toBe('1.2.3');
  });
  it('falls back to "unknown" on malformed JSON', () => {
    expect(parseVersion('not json')).toBe('unknown');
  });
  it('falls back to "unknown" when version is missing', () => {
    expect(parseVersion('{"name":"x"}')).toBe('unknown');
  });
  it('falls back to "unknown" when version is not a string', () => {
    expect(parseVersion('{"version":123}')).toBe('unknown');
  });
  it('falls back to "unknown" on an empty version string', () => {
    expect(parseVersion('{"version":""}')).toBe('unknown');
  });
});

describe('readVersion', () => {
  it('returns the version from the real package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    expect(readVersion()).toBe(pkg.version);
  });
});

describe('parseArgs configure', () => {
  it('parses --gateway-url and --api-key (space form)', () => {
    const a = parseArgs(['configure', '--gateway-url', 'https://gw', '--api-key', 'sk-1'])
    expect(a.cmd).toBe('configure'); expect(a.gatewayUrl).toBe('https://gw'); expect(a.apiKey).toBe('sk-1')
  })
  it('parses = form', () => {
    const a = parseArgs(['configure', '--gateway-url=https://gw', '--api-key=sk-2'])
    expect(a.gatewayUrl).toBe('https://gw'); expect(a.apiKey).toBe('sk-2')
  })
})

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

/**
 * cwd-resolver tests (Q3).
 *
 * Coverage:
 *  - Hash stability: same SessionCtx → same path on every call.
 *  - Hash uniqueness across DM / Group and across distinct sessionKeys.
 *  - kind-prefix separation: a dm and group key that are byte-identical differ.
 *  - mkdir idempotency on repeated resolveSessionCwd calls.
 *  - Provenance recorded in the sidecar registry (outside the session dir).
 *  - TTL cleanup deletes dirs older than ttlMs; preserves fresh dirs.
 *  - Marker self-heals on every resolve (no permanent cleanup exemption).
 *  - cleanup silently returns when cwdBase does not exist.
 *  - cleanup ignores non-hash-pattern entries (operator's own files).
 *  - cleanup only deletes dirs with a registry entry; removes the entry too.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveSessionCwd,
  cleanupExpiredCwds,
  resolveMemoryDir,
  DEFAULT_CWD_TTL_MS,
  type SessionCtx,
} from '../cwd-resolver.js';

const REGISTRY_DIR = '.cc-octo-sessions';

function expectedName(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Path to the sidecar registry marker for a given 16-hex dir name. */
function markerFor(baseDir: string, name: string): string {
  return join(baseDir, REGISTRY_DIR, name);
}

function oldTimeSeconds(days: number): number {
  return (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
}

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cwd-resolver-test-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveSessionCwd — hash stability', () => {
  it('returns the same path for repeated DM calls with the same key', () => {
    const ctx: SessionCtx = { kind: 'dm', sessionKey: 'alice' };
    const a = resolveSessionCwd(base, ctx);
    const b = resolveSessionCwd(base, ctx);
    const c = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns the same path for repeated Group calls', () => {
    const a = resolveSessionCwd(base, { kind: 'group', sessionKey: 'gid-1:bob' });
    const b = resolveSessionCwd(base, { kind: 'group', sessionKey: 'gid-1:bob' });
    expect(a).toBe(b);
  });
});

describe('resolveSessionCwd — hash uniqueness', () => {
  it('different DM keys map to different dirs', () => {
    const a = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    const b = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'bob' });
    expect(a).not.toBe(b);
  });

  it('different group sessionKeys map to different dirs', () => {
    const a = resolveSessionCwd(base, { kind: 'group', sessionKey: 'g1:alice' });
    const b = resolveSessionCwd(base, { kind: 'group', sessionKey: 'g1:bob' });
    expect(a).not.toBe(b);
  });

  it('same uid in different spaces maps to different dirs (router key differs)', () => {
    // Router DM key is `${spaceId}:${uid}` — the resolver just hashes it.
    const a = resolveSessionCwd(base, { kind: 'dm', sessionKey: 's1:alice' });
    const b = resolveSessionCwd(base, { kind: 'dm', sessionKey: 's2:alice' });
    expect(a).not.toBe(b);
    expect(basename(a)).toBe(expectedName('dm:s1:alice'));
    expect(basename(b)).toBe(expectedName('dm:s2:alice'));
  });

  it('hashes the kind-prefixed router key', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    expect(basename(dir)).toBe(expectedName('dm:alice'));
  });

  it('kind-prefix separation: a dm and group key that are byte-identical differ', () => {
    const dm = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'foo' });
    const grp = resolveSessionCwd(base, { kind: 'group', sessionKey: 'foo' });
    expect(dm).not.toBe(grp);
    expect(basename(dm)).toBe(expectedName('dm:foo'));
    expect(basename(grp)).toBe(expectedName('group:foo'));
  });

  it('distinct group sessionKeys map to distinct dirs (resolver is key-agnostic)', () => {
    // NOTE: the resolver just hashes whatever sessionKey it's given. As of the
    // shared-group change, SessionRouter produces ONE key per channel, so group
    // members now share a dir — that grouping decision lives in the router, not
    // here. This test only asserts the resolver keeps distinct keys distinct.
    const a = resolveSessionCwd(base, { kind: 'group', sessionKey: 'gA' });
    const b = resolveSessionCwd(base, { kind: 'group', sessionKey: 'gB' });
    expect(a).not.toBe(b);
  });
});

describe('resolveSessionCwd — directory creation', () => {
  it('creates a 16-hex subdir under cwdBase', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    expect(existsSync(dir)).toBe(true);
    const stat = statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    const name = dir.substring(dir.lastIndexOf('/') + 1);
    expect(name).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records provenance in the sidecar registry (NOT inside the session dir)', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    const name = basename(dir);
    // Marker lives in the registry, outside the agent's own cwd.
    expect(existsSync(markerFor(base, name))).toBe(true);
    // Nothing leaks into the session dir itself.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('mkdir is idempotent — repeated calls do not throw', () => {
    const ctx: SessionCtx = { kind: 'dm', sessionKey: 'alice' };
    expect(() => {
      for (let i = 0; i < 5; i++) resolveSessionCwd(base, ctx);
    }).not.toThrow();
  });

  it('re-creates a missing registry marker on the next resolve (self-heal)', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    const name = basename(dir);
    const marker = markerFor(base, name);
    expect(existsSync(marker)).toBe(true);
    // Simulate a first-write failure / external deletion of the marker.
    rmSync(marker, { force: true });
    expect(existsSync(marker)).toBe(false);
    // Next resolve must restore it so the dir stays cleanup-eligible.
    resolveSessionCwd(base, { kind: 'dm', sessionKey: 'alice' });
    expect(existsSync(marker)).toBe(true);
  });

  it('creates cwdBase itself if missing', () => {
    const nested = join(base, 'nested', 'deeper');
    expect(existsSync(nested)).toBe(false);
    const dir = resolveSessionCwd(nested, { kind: 'dm', sessionKey: 'x' });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('cleanupExpiredCwds — TTL behavior', () => {
  it('removes a session dir whose mtime is older than ttlMs', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'stale' });
    // Force mtime ~8 days in the past
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the registry marker alongside the deleted dir', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'stale' });
    const name = basename(dir);
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(markerFor(base, name))).toBe(false);
  });

  it('preserves a session dir whose mtime is within ttlMs', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'fresh' });
    // mtime is "now" by virtue of just being created
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(dir)).toBe(true);
  });

  it('refreshes an old active session mtime before cleanup can delete it', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'active' });
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);

    resolveSessionCwd(base, { kind: 'dm', sessionKey: 'active' });
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(dir)).toBe(true);
  });

  it('removes only the expired dir when both fresh + stale coexist', () => {
    const fresh = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'fresh' });
    const stale = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'stale' });
    const oldTime = oldTimeSeconds(30);
    utimesSync(stale, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});

describe('cleanupExpiredCwds — safety', () => {
  it('does NOT throw when cwdBase does not exist', () => {
    const missing = join(base, 'never-created');
    expect(() => cleanupExpiredCwds(missing)).not.toThrow();
  });

  it('ignores files / dirs whose name does not match the hash pattern', () => {
    // Operator-owned scratch files
    const scratch = join(base, 'README.txt');
    writeFileSync(scratch, 'do not delete');
    const otherDir = join(base, 'not-a-session');
    mkdirSync(otherDir);
    const oldTime = oldTimeSeconds(30);
    utimesSync(scratch, oldTime, oldTime);
    utimesSync(otherDir, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(otherDir)).toBe(true);
  });

  it('does not delete an old 16-hex dir without a registry marker', () => {
    // A 16-hex dir from some OTHER tool — we never created a registry entry.
    const unrelated = join(base, '0123456789abcdef');
    mkdirSync(unrelated);
    const oldTime = oldTimeSeconds(8);
    utimesSync(unrelated, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(unrelated)).toBe(true);
  });

  it('does not delete a 16-hex dir whose marker was deleted from the registry', () => {
    // Even if an in-cwd marker were forged by the agent, the registry (outside
    // the cwd) is the source of truth — a missing registry entry protects it.
    const dir = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'victim' });
    const name = basename(dir);
    rmSync(markerFor(base, name), { force: true });
    // Agent forges an in-cwd marker (old-style) — must NOT make it eligible.
    writeFileSync(join(dir, '.cc-octo-session'), 'forged');
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(dir)).toBe(true);
  });

  it('does not delete a recent 16-hex dir with a registry marker', () => {
    const name = 'abcdef0123456789';
    const recent = join(base, name);
    mkdirSync(recent);
    mkdirSync(join(base, REGISTRY_DIR), { recursive: true });
    writeFileSync(markerFor(base, name), '{"created":"now","kind":"dm"}');

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(recent)).toBe(true);
  });

  it('deletes an old 16-hex dir with a registry marker', () => {
    const name = 'fedcba9876543210';
    const stale = join(base, name);
    mkdirSync(stale);
    mkdirSync(join(base, REGISTRY_DIR), { recursive: true });
    writeFileSync(markerFor(base, name), '{"created":"old","kind":"dm"}');
    const oldTime = oldTimeSeconds(8);
    utimesSync(stale, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(stale)).toBe(false);
  });

  it('survives a malformed entry without aborting the sweep', () => {
    // Create one stale + one fresh; even if listing hits an oddball file the
    // sweep should still delete the stale session.
    const stale = resolveSessionCwd(base, { kind: 'dm', sessionKey: 'stale' });
    writeFileSync(join(base, 'sidecar.log'), 'noise');
    const oldTime = oldTimeSeconds(30);
    utimesSync(stale, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(base)).toContain('sidecar.log');
  });
});

describe('resolveMemoryDir (v1.1) — pure, stable, no fs side effects', () => {
  let mbase: string;
  beforeEach(() => { mbase = mkdtempSync(join(tmpdir(), 'memdir-test-')); });
  afterEach(() => { rmSync(mbase, { recursive: true, force: true }); });

  it('is deterministic for a given (kind, sessionKey)', () => {
    const ctx: SessionCtx = { kind: 'group', sessionKey: 'chan-1' };
    expect(resolveMemoryDir(mbase, ctx)).toBe(resolveMemoryDir(mbase, ctx));
  });

  it('hashes the kind-prefixed key (matches cwd scheme) under memoryBase', () => {
    const dir = resolveMemoryDir(mbase, { kind: 'group', sessionKey: 'chan-1' });
    expect(dir).toBe(join(mbase, expectedName('group:chan-1')));
  });

  it('separates dm vs group with identical key', () => {
    const dm = resolveMemoryDir(mbase, { kind: 'dm', sessionKey: 'x' });
    const grp = resolveMemoryDir(mbase, { kind: 'group', sessionKey: 'x' });
    expect(dm).not.toBe(grp);
  });

  it('is PURE — creates no directory, no registry marker (SDK owns the dir, no TTL)', () => {
    const before = readdirSync(mbase).sort();
    resolveMemoryDir(mbase, { kind: 'dm', sessionKey: 'alice' });
    expect(readdirSync(mbase).sort()).toEqual(before); // nothing written
    expect(existsSync(join(mbase, REGISTRY_DIR))).toBe(false);
  });
});

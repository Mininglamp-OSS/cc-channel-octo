/**
 * cwd-resolver tests (Q3).
 *
 * Coverage:
 *  - Hash stability: same SessionCtx → same path on every call.
 *  - Hash uniqueness across DM / Group / Thread namespaces.
 *  - mkdir idempotency on repeated resolveSessionCwd calls.
 *  - TTL cleanup deletes dirs older than ttlMs; preserves fresh dirs.
 *  - cleanup silently returns when cwdBase does not exist.
 *  - cleanup ignores non-hash-pattern entries (operator's own files).
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
  DEFAULT_CWD_TTL_MS,
  type SessionCtx,
} from '../cwd-resolver.js';

const MARKER = '.cc-octo-session';

function expectedName(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
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
  it('returns the same path for repeated DM calls with the same uid', () => {
    const ctx: SessionCtx = { kind: 'dm', userId: 'alice' };
    const a = resolveSessionCwd(base, ctx);
    const b = resolveSessionCwd(base, ctx);
    const c = resolveSessionCwd(base, { kind: 'dm', userId: 'alice' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns the same path for repeated Group calls', () => {
    const a = resolveSessionCwd(base, { kind: 'group', groupId: 'gid-1' });
    const b = resolveSessionCwd(base, { kind: 'group', groupId: 'gid-1' });
    expect(a).toBe(b);
  });

  it('returns the same path for repeated Thread calls', () => {
    const a = resolveSessionCwd(base, { kind: 'thread', groupId: 'g', threadId: 't' });
    const b = resolveSessionCwd(base, { kind: 'thread', groupId: 'g', threadId: 't' });
    expect(a).toBe(b);
  });
});

describe('resolveSessionCwd — hash uniqueness', () => {
  it('different DM uids map to different dirs', () => {
    const a = resolveSessionCwd(base, { kind: 'dm', userId: 'alice' });
    const b = resolveSessionCwd(base, { kind: 'dm', userId: 'bob' });
    expect(a).not.toBe(b);
  });

  it('different Group ids map to different dirs', () => {
    const a = resolveSessionCwd(base, { kind: 'group', groupId: 'g1' });
    const b = resolveSessionCwd(base, { kind: 'group', groupId: 'g2' });
    expect(a).not.toBe(b);
  });

  it('same DM uid in different spaces maps to different dirs', () => {
    const a = resolveSessionCwd(base, { kind: 'dm', userId: 'alice', spaceId: 's1' });
    const b = resolveSessionCwd(base, { kind: 'dm', userId: 'alice', spaceId: 's2' });
    expect(a).not.toBe(b);
    expect(basename(a)).toBe(expectedName('dm:s1:alice'));
    expect(basename(b)).toBe(expectedName('dm:s2:alice'));
  });

  it('DM uid without spaceId keeps the legacy hash', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'alice' });
    expect(basename(dir)).toBe(expectedName('dm:alice'));
  });

  it('namespace separation: dm:foo != group:foo', () => {
    const dm = resolveSessionCwd(base, { kind: 'dm', userId: 'foo' });
    const grp = resolveSessionCwd(base, { kind: 'group', groupId: 'foo' });
    expect(dm).not.toBe(grp);
  });

  it('thread != its parent group', () => {
    const grp = resolveSessionCwd(base, { kind: 'group', groupId: 'gA' });
    const thr = resolveSessionCwd(base, { kind: 'thread', groupId: 'gA', threadId: 'tX' });
    expect(grp).not.toBe(thr);
  });

  it('different thread ids under the same group are isolated', () => {
    const t1 = resolveSessionCwd(base, { kind: 'thread', groupId: 'g', threadId: 't1' });
    const t2 = resolveSessionCwd(base, { kind: 'thread', groupId: 'g', threadId: 't2' });
    expect(t1).not.toBe(t2);
  });
});

describe('resolveSessionCwd — directory creation', () => {
  it('creates a 16-hex subdir under cwdBase', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'alice' });
    expect(existsSync(dir)).toBe(true);
    const stat = statSync(dir);
    expect(stat.isDirectory()).toBe(true);
    const name = dir.substring(dir.lastIndexOf('/') + 1);
    expect(name).toMatch(/^[0-9a-f]{16}$/);
  });

  it('writes a session provenance marker', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'alice' });
    expect(existsSync(join(dir, MARKER))).toBe(true);
  });

  it('mkdir is idempotent — repeated calls do not throw', () => {
    const ctx: SessionCtx = { kind: 'dm', userId: 'alice' };
    expect(() => {
      for (let i = 0; i < 5; i++) resolveSessionCwd(base, ctx);
    }).not.toThrow();
  });

  it('creates cwdBase itself if missing', () => {
    const nested = join(base, 'nested', 'deeper');
    expect(existsSync(nested)).toBe(false);
    const dir = resolveSessionCwd(nested, { kind: 'dm', userId: 'x' });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('cleanupExpiredCwds — TTL behavior', () => {
  it('removes a session dir whose mtime is older than ttlMs', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'stale' });
    // Force mtime ~8 days in the past
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(dir)).toBe(false);
  });

  it('preserves a session dir whose mtime is within ttlMs', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'fresh' });
    // mtime is "now" by virtue of just being created
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(dir)).toBe(true);
  });

  it('refreshes an old active session mtime before cleanup can delete it', () => {
    const dir = resolveSessionCwd(base, { kind: 'dm', userId: 'active' });
    const oldTime = oldTimeSeconds(8);
    utimesSync(dir, oldTime, oldTime);

    resolveSessionCwd(base, { kind: 'dm', userId: 'active' });
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(dir)).toBe(true);
  });

  it('removes only the expired dir when both fresh + stale coexist', () => {
    const fresh = resolveSessionCwd(base, { kind: 'dm', userId: 'fresh' });
    const stale = resolveSessionCwd(base, { kind: 'dm', userId: 'stale' });
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

  it('does not delete an old 16-hex dir without the session marker', () => {
    const unrelated = join(base, '0123456789abcdef');
    mkdirSync(unrelated);
    const oldTime = oldTimeSeconds(8);
    utimesSync(unrelated, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(unrelated)).toBe(true);
  });

  it('does not delete a recent 16-hex dir with the session marker', () => {
    const recent = join(base, 'abcdef0123456789');
    mkdirSync(recent);
    writeFileSync(join(recent, MARKER), '{"created":"now","kind":"dm"}');

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(recent)).toBe(true);
  });

  it('deletes an old 16-hex dir with the session marker', () => {
    const stale = join(base, 'fedcba9876543210');
    mkdirSync(stale);
    writeFileSync(join(stale, MARKER), '{"created":"old","kind":"dm"}');
    const oldTime = oldTimeSeconds(8);
    utimesSync(stale, oldTime, oldTime);

    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);

    expect(existsSync(stale)).toBe(false);
  });

  it('survives a malformed entry without aborting the sweep', () => {
    // Create one stale + one fresh; even if listing hits an oddball file the
    // sweep should still delete the stale session.
    const stale = resolveSessionCwd(base, { kind: 'dm', userId: 'stale' });
    writeFileSync(join(base, 'sidecar.log'), 'noise');
    const oldTime = oldTimeSeconds(30);
    utimesSync(stale, oldTime, oldTime);
    cleanupExpiredCwds(base, DEFAULT_CWD_TTL_MS);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(base)).toContain('sidecar.log');
  });
});

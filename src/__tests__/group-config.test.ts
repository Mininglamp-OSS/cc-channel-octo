/**
 * group-config tests (v1.0 GROUP.md/THREAD.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { loadGroupConfig, MAX_GROUP_CONFIG_BYTES } from '../group-config.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'group-config-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadGroupConfig', () => {
  it('returns undefined when groupConfigDir is unset', () => {
    expect(loadGroupConfig(undefined, 'g1')).toBeUndefined();
  });

  it('returns undefined when no file matches', () => {
    expect(loadGroupConfig(dir, 'g1')).toBeUndefined();
  });

  it('loads <groupId>.md contents (trimmed)', () => {
    writeFileSync(join(dir, 'g1.md'), '\n  Be terse and formal.\n');
    expect(loadGroupConfig(dir, 'g1')).toBe('Be terse and formal.');
  });

  it('is keyed per group id', () => {
    writeFileSync(join(dir, 'g1.md'), 'one');
    writeFileSync(join(dir, 'g2.md'), 'two');
    expect(loadGroupConfig(dir, 'g1')).toBe('one');
    expect(loadGroupConfig(dir, 'g2')).toBe('two');
  });

  it('returns undefined for an empty / whitespace-only file', () => {
    writeFileSync(join(dir, 'g1.md'), '   \n  ');
    expect(loadGroupConfig(dir, 'g1')).toBeUndefined();
  });

  it('truncates an oversized file to the byte cap', () => {
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(MAX_GROUP_CONFIG_BYTES + 5000));
    const out = loadGroupConfig(dir, 'big')!;
    expect(out).toContain('[… group config truncated]');
    expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(MAX_GROUP_CONFIG_BYTES + 100);
  });

  it.each(['../etc', 'a/b', '.', '..', 'a\\b', 'with space', ''])(
    'rejects unsafe/empty group id %j (no traversal)',
    (badId) => {
      // Even if a file with that literal name somehow existed, the id is rejected.
      expect(loadGroupConfig(dir, badId)).toBeUndefined();
    },
  );

  it('does not follow a directory named like the file', () => {
    mkdirSync(join(dir, 'g1.md'));
    expect(loadGroupConfig(dir, 'g1')).toBeUndefined();
  });

  it('does not throw when groupConfigDir does not exist', () => {
    expect(() => loadGroupConfig(join(dir, 'missing'), 'g1')).not.toThrow();
    expect(loadGroupConfig(join(dir, 'missing'), 'g1')).toBeUndefined();
  });

  const itPosix = platform() === 'win32' ? it.skip : it;

  itPosix('refuses a world-writable file (defense-in-depth)', () => {
    const p = join(dir, 'g1.md');
    writeFileSync(p, 'instructions');
    chmodSync(p, 0o646); // world-writable
    expect(loadGroupConfig(dir, 'g1')).toBeUndefined();
  });

  itPosix('refuses a group-writable file', () => {
    const p = join(dir, 'g1.md');
    writeFileSync(p, 'instructions');
    chmodSync(p, 0o664); // group-writable
    expect(loadGroupConfig(dir, 'g1')).toBeUndefined();
  });

  itPosix('accepts an owner-only / non-group-writable file', () => {
    const p = join(dir, 'g1.md');
    writeFileSync(p, 'instructions');
    chmodSync(p, 0o644); // owner-write, others read-only
    expect(loadGroupConfig(dir, 'g1')).toBe('instructions');
  });
});

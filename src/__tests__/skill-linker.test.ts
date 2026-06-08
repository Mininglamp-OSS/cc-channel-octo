/**
 * #100: skill-linker tests — verify the generic symlink loader.
 *
 * Uses a real temp filesystem (the module is thin fs glue; mocking fs would test
 * nothing). Covers: link creation, two-layer precedence (per-bot overrides
 * global), missing source skipped, stale link pruned, agent's real files
 * respected, idempotency, and best-effort (never throws).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
  existsSync, lstatSync, readlinkSync, readdirSync,
} from 'node:fs';

import { linkSkillsIntoSandbox } from '../skill-linker.js';

let root: string;
let sandbox: string;
let globalSkills: string;
let botSkills: string;

function makeSkill(base: string, name: string, body = '# skill\n'): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} test\n---\n${body}`);
  return dir;
}

function linkTarget(p: string): string {
  return readlinkSync(p);
}

describe('linkSkillsIntoSandbox (#100)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-skilllink-'));
    sandbox = join(root, 'sandbox');
    globalSkills = join(root, 'global-skills');
    botSkills = join(root, 'bot-skills');
    mkdirSync(sandbox, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const skillsRoot = (): string => join(sandbox, '.claude', 'skills');

  it('symlinks each skill from a single source into <sandbox>/.claude/skills/', () => {
    makeSkill(globalSkills, 'octo');
    makeSkill(globalSkills, 'gh');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    expect(lstatSync(join(skillsRoot(), 'octo')).isSymbolicLink()).toBe(true);
    expect(linkTarget(join(skillsRoot(), 'octo'))).toBe(join(globalSkills, 'octo'));
    expect(existsSync(join(skillsRoot(), 'gh', 'SKILL.md'))).toBe(true); // resolves through link
  });

  it('per-bot source overrides global on a name collision (later source wins)', () => {
    makeSkill(globalSkills, 'octo', '# GLOBAL\n');
    makeSkill(botSkills, 'octo', '# PERBOT\n');
    linkSkillsIntoSandbox(sandbox, [globalSkills, botSkills]);
    expect(linkTarget(join(skillsRoot(), 'octo'))).toBe(join(botSkills, 'octo'));
  });

  it('links from BOTH layers when names differ', () => {
    makeSkill(globalSkills, 'shared');
    makeSkill(botSkills, 'private');
    linkSkillsIntoSandbox(sandbox, [globalSkills, botSkills]);
    expect(linkTarget(join(skillsRoot(), 'shared'))).toBe(join(globalSkills, 'shared'));
    expect(linkTarget(join(skillsRoot(), 'private'))).toBe(join(botSkills, 'private'));
  });

  it('skips a missing source dir without throwing', () => {
    makeSkill(botSkills, 'only');
    // globalSkills does not exist
    expect(() => linkSkillsIntoSandbox(sandbox, [globalSkills, botSkills])).not.toThrow();
    expect(existsSync(join(skillsRoot(), 'only'))).toBe(true);
  });

  it('prunes a managed link whose skill was removed from the source', () => {
    makeSkill(globalSkills, 'octo');
    makeSkill(globalSkills, 'gh');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    expect(existsSync(join(skillsRoot(), 'gh'))).toBe(true);
    // remove gh from the source, re-run
    rmSync(join(globalSkills, 'gh'), { recursive: true, force: true });
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    expect(lstatExists(join(skillsRoot(), 'gh'))).toBe(false); // link pruned
    expect(existsSync(join(skillsRoot(), 'octo'))).toBe(true); // octo kept
  });

  it('re-points a managed link when the winning source changes', () => {
    makeSkill(globalSkills, 'octo', '# G\n');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    expect(linkTarget(join(skillsRoot(), 'octo'))).toBe(join(globalSkills, 'octo'));
    // now a per-bot skill of the same name appears → should win
    makeSkill(botSkills, 'octo', '# B\n');
    linkSkillsIntoSandbox(sandbox, [globalSkills, botSkills]);
    expect(linkTarget(join(skillsRoot(), 'octo'))).toBe(join(botSkills, 'octo'));
  });

  it('never clobbers a real (non-symlink) entry the agent created', () => {
    makeSkill(globalSkills, 'octo');
    // agent wrote its own real dir named 'octo' in the sandbox skills root
    mkdirSync(skillsRoot(), { recursive: true });
    const real = join(skillsRoot(), 'octo');
    mkdirSync(real);
    writeFileSync(join(real, 'AGENT.md'), 'mine');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    // still a real dir, not replaced by a symlink
    expect(lstatSync(real).isSymbolicLink()).toBe(false);
    expect(existsSync(join(real, 'AGENT.md'))).toBe(true);
  });

  it('is idempotent — re-running makes no change', () => {
    makeSkill(globalSkills, 'octo');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    const before = readlinkSync(join(skillsRoot(), 'octo'));
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    const after = readlinkSync(join(skillsRoot(), 'octo'));
    expect(after).toBe(before);
    expect(readdirSync(skillsRoot())).toEqual(['octo']);
  });

  it('ignores dotfiles and stray files in the source', () => {
    mkdirSync(globalSkills, { recursive: true });
    writeFileSync(join(globalSkills, 'README.md'), 'not a skill'); // stray file
    mkdirSync(join(globalSkills, '.hidden')); // dotdir
    makeSkill(globalSkills, 'octo');
    linkSkillsIntoSandbox(sandbox, [globalSkills]);
    expect(readdirSync(skillsRoot())).toEqual(['octo']);
  });
});

/** lstat-based existence (does not follow symlinks). */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

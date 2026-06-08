/**
 * #100: Generic skill linking.
 *
 * cc supports external tooling (octo-cli, gh, anything) purely as DATA: the
 * operator drops standard Claude skills into a `skills/` directory and cc loads
 * them — no per-tool code. The SDK only discovers skills under a session's
 * `<cwd>/.claude/skills/` when `settingSources` includes `project`, so for each
 * turn we symlink the operator-owned skill dirs into the session sandbox.
 *
 * Two layers, mirroring config: an install-wide `<baseDir>/skills` shared by all
 * bots, and a per-bot `<baseDir>/<id>/skills`. Per-bot overrides global on a name
 * collision (pass sources as [global, perBot] — later wins).
 *
 * The links point OUTSIDE the sandbox to the operator-owned skill dirs, so the
 * 7-day cwd TTL sweep removes only the links, never the real skills. We only ever
 * manage symlinks we created (real files/dirs the agent placed are left alone),
 * and we prune managed links whose source skill has disappeared so a removed
 * skill stops being offered.
 *
 * Best-effort throughout: a missing source dir is skipped, any per-link error is
 * logged and skipped, and the function never throws — a skill-linking failure
 * must not break a turn.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/** Sandbox subpath the SDK scans for project-scope skills. */
const SKILLS_SUBPATH = join('.claude', 'skills');

/**
 * Symlink every skill found under `sources` into `<sandboxDir>/.claude/skills/`.
 *
 * @param sandboxDir - the resolved per-session cwd (the agent's working dir)
 * @param sources - skill source dirs in ascending precedence (later wins on a
 *   name collision). Typically `[globalSkillsDir, perBotSkillsDir]`.
 */
export function linkSkillsIntoSandbox(sandboxDir: string, sources: string[]): void {
  const skillsRoot = join(sandboxDir, SKILLS_SUBPATH);

  // Collect desired links: skillName → absolute source path. Later sources
  // overwrite earlier ones, so per-bot shadows global.
  const desired = new Map<string, string>();
  for (const src of sources) {
    let entries: string[];
    try {
      if (!existsSync(src)) continue;
      entries = readdirSync(src);
    } catch (err) {
      console.error(`[cc-channel-octo] skill source unreadable ${src}: ${String(err)}`);
      continue;
    }
    for (const name of entries) {
      // A skill is a directory (or a symlink to one); skip dotfiles / stray files.
      if (name.startsWith('.')) continue;
      const target = join(src, name);
      try {
        if (lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
          desired.set(name, target);
        }
      } catch {
        // racing removal — skip
      }
    }
  }

  try {
    mkdirSync(skillsRoot, { recursive: true });
  } catch (err) {
    console.error(`[cc-channel-octo] cannot create skills dir ${skillsRoot}: ${String(err)}`);
    return; // nothing else we can do
  }

  // Prune managed (symlink) entries that are no longer desired or whose target
  // vanished. Never touch real dirs/files (the agent may have created its own).
  let existing: string[] = [];
  try {
    existing = readdirSync(skillsRoot);
  } catch {
    existing = [];
  }
  for (const name of existing) {
    const linkPath = join(skillsRoot, name);
    let isLink = false;
    try {
      isLink = lstatSync(linkPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (!isLink) continue; // leave real entries alone
    const wanted = desired.get(name);
    let currentTarget: string | undefined;
    try {
      currentTarget = readlinkSync(linkPath);
    } catch {
      currentTarget = undefined;
    }
    // Remove if: not wanted anymore, points elsewhere now, or target gone.
    if (!wanted || currentTarget !== wanted || !existsSync(linkPath)) {
      try {
        rmSync(linkPath, { force: true });
      } catch (err) {
        console.error(`[cc-channel-octo] failed pruning skill link ${linkPath}: ${String(err)}`);
      }
    }
  }

  // Create desired links. The prune pass above already removed any managed link
  // that was wrong/stale/dangling, so here: skip if a real entry shadows the
  // name (agent's own file wins) or a correct symlink already exists; else link.
  for (const [name, target] of desired) {
    const linkPath = join(skillsRoot, name);
    try {
      if (isSymlink(linkPath)) {
        if (readlinkSafe(linkPath) === target) continue; // already correct
        rmSync(linkPath, { force: true }); // wrong target → replace
      } else if (lstatExists(linkPath)) {
        continue; // a real dir/file shadows this skill name — respect it
      }
      symlinkSync(target, linkPath);
    } catch (err) {
      console.error(`[cc-channel-octo] failed linking skill ${name} → ${target}: ${String(err)}`);
    }
  }
}

/** True when `p` exists as any kind of entry (does not follow symlinks). */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `p` exists and is a symlink (false on any error). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** readlink that returns undefined on error. */
function readlinkSafe(p: string): string | undefined {
  try {
    return readlinkSync(p);
  } catch {
    return undefined;
  }
}

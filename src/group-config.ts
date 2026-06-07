/**
 * v1.0: GROUP.md / THREAD.md per-conversation instruction files.
 *
 * Operators can drop a markdown file with custom instructions for a specific
 * group (or, later, thread) into a configured directory. Its contents are
 * injected into the agent's system prompt as a trusted instruction block, so a
 * group can have its own persona / rules without code changes.
 *
 * SECURITY: these files are OPERATOR-controlled, NOT agent- or user-writable.
 * They live in `config.groupConfigDir` (a path the operator manages), never in
 * the per-session cwd sandbox (which the agent can write). That's the whole
 * point — system-prompt-level instructions must come from a trusted source.
 * The lookup is filename-pinned to a sanitized id so a crafted group/thread id
 * can't traverse out of the config dir.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Max bytes of an instruction file we will inject (keeps the prompt bounded). */
export const MAX_GROUP_CONFIG_BYTES = 16_384; // 16 KiB

/**
 * Only allow ids that are safe as a single path segment — letters, digits, and
 * a few separators. Anything else (slashes, dots-only, `..`) is rejected so a
 * channel/thread id cannot escape `groupConfigDir`.
 */
function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/**
 * Load the instruction file for a group, or undefined when none applies.
 *
 * Looks for `<groupConfigDir>/<groupId>.md`. Returns the trimmed contents,
 * truncated to MAX_GROUP_CONFIG_BYTES. Returns undefined when:
 *   - groupConfigDir is not configured,
 *   - groupId is empty or unsafe as a path segment,
 *   - the file does not exist or is unreadable.
 *
 * Never throws — a misconfigured dir or unreadable file degrades to "no custom
 * instructions" rather than failing the turn.
 */
export function loadGroupConfig(
  groupConfigDir: string | undefined,
  groupId: string,
): string | undefined {
  if (!groupConfigDir) return undefined;
  if (!groupId || !isSafeId(groupId)) return undefined;

  const path = join(groupConfigDir, `${groupId}.md`);
  try {
    if (!existsSync(path)) return undefined;
    if (!statSync(path).isFile()) return undefined;
    // Read at most MAX+1 bytes so a mistakenly huge file can't block the event
    // loop or allocate unbounded memory on every group turn. Reading one extra
    // byte lets us detect (and mark) truncation.
    const fd = openSync(path, 'r');
    let content: string;
    let wasTruncated = false;
    try {
      const buf = Buffer.allocUnsafe(MAX_GROUP_CONFIG_BYTES + 1);
      const bytesRead = readSync(fd, buf, 0, MAX_GROUP_CONFIG_BYTES + 1, 0);
      wasTruncated = bytesRead > MAX_GROUP_CONFIG_BYTES;
      const slice = buf.subarray(0, Math.min(bytesRead, MAX_GROUP_CONFIG_BYTES));
      content = slice.toString('utf-8');
    } finally {
      closeSync(fd);
    }
    if (wasTruncated) {
      // The slice may end mid-codepoint; trim back to a valid UTF-8 boundary by
      // dropping any trailing replacement char produced by a split sequence.
      content = content.replace(/�+$/, '');
      content += '\n[… group config truncated]';
    }
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    console.error(`[cc-channel-octo] group config read failed for ${path}: ${String(err)}`);
    return undefined;
  }
}

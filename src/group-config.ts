/**
 * v1.0: GROUP.md / THREAD.md per-conversation instruction files.
 *
 * Operators can drop a markdown file with custom instructions for a specific
 * group (or, later, thread) into a configured directory. Its contents are
 * injected into the agent's system prompt as a trusted instruction block, so a
 * group can have its own persona / rules without code changes.
 *
 * SECURITY — read carefully. The `[Group instructions]` block is injected into
 * the system prompt UNSANITIZED, so its contents are trusted. That trust holds
 * ONLY if the file is writable solely by the operator (the gateway process user).
 *
 * Placing `groupConfigDir` outside `cwdBase` is necessary but NOT sufficient:
 * under the shipped defaults (`allowedTools: '*'`, `bypassPermissions`) the agent
 * has `Bash`/`Write` and can write ABSOLUTE paths anywhere the gateway user can
 * write — `cwdBase` is a starting dir, not a chroot. So a malicious user in one
 * group could drive the agent to write `<groupConfigDir>/<otherGroup>.md` and
 * inject persistent, trusted instructions into a different group.
 *
 * The real protection is OS-level: `groupConfigDir` and its files MUST be made
 * non-writable by the gateway process user (e.g. root-owned, mode 0755/0644),
 * and/or the deployment hardened (drop `Bash`, sandboxed FS, unprivileged user).
 * As cheap defense-in-depth, loadGroupConfig() refuses to inject a file that is
 * group- or world-writable. The group id is filename-pinned to a safe slug so a
 * crafted id can't traverse out of the config dir.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractThreadShortId, isThreadChannelId } from './octo/channel-id.js';

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
 * Load the instruction file for a channel, or undefined when none applies.
 *
 * Routing by channel-id shape:
 *   - Plain group (`<groupNo>`, no separator): looks for `<groupNo>.md`.
 *     Byte-identical to the pre-thread behavior.
 *   - Thread (`<groupNo>____<shortId>`, CommunityTopic): a thread carries its
 *     OWN instructions, not the parent group's, so the NEW semantics looks for
 *     `<shortId>.md` (the thread's own slug). To avoid breaking deployments
 *     that dropped a whole-composite `<groupNo>____<shortId>.md` file under the
 *     old "channel_id as filename" behavior, it then falls back to that legacy
 *     name when the short-id file is absent (compat lookup — see #88 redline 5).
 *
 * ⚠️ Path-semantics change (redline 5): before this change a thread channel_id
 * was used verbatim as the filename; now the short id is the primary slug and
 * the whole-composite name is only a fallback. A thread no longer inherits its
 * parent group's `<groupNo>.md` (decision A: thread injects its own file only).
 *
 * Returns the trimmed contents, truncated to MAX_GROUP_CONFIG_BYTES, or
 * undefined when no file applies. Never throws.
 */
export function loadGroupConfig(
  groupConfigDir: string | undefined,
  channelId: string,
): string | undefined {
  if (!groupConfigDir) return undefined;
  if (!channelId) return undefined;

  if (isThreadChannelId(channelId)) {
    // New semantics: the thread's own short-id file first…
    const shortId = extractThreadShortId(channelId);
    if (shortId) {
      const byShortId = loadConfigFile(groupConfigDir, shortId);
      if (byShortId !== undefined) return byShortId;
    }
    // …then the legacy whole-composite filename for backward compatibility.
    return loadConfigFile(groupConfigDir, channelId);
  }

  return loadConfigFile(groupConfigDir, channelId);
}

/**
 * Read a single instruction file `<groupConfigDir>/<slug>.md`, or undefined.
 *
 * Returns the trimmed contents, truncated to MAX_GROUP_CONFIG_BYTES. Returns
 * undefined when:
 *   - slug is empty or unsafe as a path segment,
 *   - the file does not exist or is unreadable.
 *
 * Never throws — a misconfigured dir or unreadable file degrades to "no custom
 * instructions" rather than failing the turn.
 */
function loadConfigFile(
  groupConfigDir: string,
  slug: string,
): string | undefined {
  if (!slug || !isSafeId(slug)) return undefined;

  const path = join(groupConfigDir, `${slug}.md`);
  try {
    if (!existsSync(path)) return undefined;
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    // Defense-in-depth: refuse a group/world-writable file. Its contents are
    // injected UNSANITIZED into the system prompt, so a file anyone-but-the-
    // operator can write is an untrusted injection sink. This catches the most
    // common misconfiguration; it is NOT a substitute for proper OS perms +
    // a hardened deployment (the agent can still write operator-owned paths
    // under default Bash/bypassPermissions — see the module header).
    if ((st.mode & 0o022) !== 0) {
      console.error(
        `[cc-channel-octo] refusing group config ${path}: file is group/world-writable ` +
        `(mode ${(st.mode & 0o777).toString(8)}). Make it writable only by the gateway user.`,
      );
      return undefined;
    }
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

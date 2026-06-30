/**
 * GROUP.md resolution (P2-A): server-first fetch with a never-lose local-file
 * fallback, behind a feature flag.
 *
 * `resolveGroupInstructions` is the single entry point the message pipeline
 * calls to obtain the trusted per-group instruction block injected into the
 * agent's system prompt. Resolution order:
 *
 *   1. Feature flag OFF (default) or no cache wired → pure local file
 *      (`loadGroupConfig`). Byte-identical to the pre-P2 behavior, so existing
 *      local-file deployments are unaffected.
 *   2. Feature flag ON:
 *        a. serve a cached server GROUP.md if present (keyed by the PARENT group
 *           number — a thread shares its parent group's GROUP.md);
 *        b. otherwise fetch from the server (server-first). On success with
 *           non-empty content, cache it and use it;
 *        c. on ANY failure (404 "no GROUP.md", network, timeout, empty content)
 *           fall back to the local file. The local-file path is never lost.
 *
 * Thread routing (P1): a thread channelId is the composite `<groupNo>____<shortId>`.
 * The server GROUP.md endpoint is keyed by the parent group number, so we resolve
 * it with `extractParentGroupNo` for the API call + cache key (identity for a
 * plain group). The local-file fallback still receives the FULL channelId so its
 * own thread/short-id routing in `loadGroupConfig` is preserved unchanged.
 *
 * Never throws — a server error degrades to local, a local miss degrades to
 * "no custom instructions".
 */

import { getGroupMd } from './octo/api.js';
import { extractParentGroupNo } from './octo/channel-id.js';
import { loadGroupConfig, MAX_GROUP_CONFIG_BYTES } from './group-config.js';
import type { GroupMdCache, GroupMdEntry } from './group-md-cache.js';

/**
 * Trim and byte-bound server-provided GROUP.md the same way loadGroupConfig
 * bounds a local file, so an oversized server payload can't blow the prompt
 * budget. Returns undefined for empty/whitespace-only content.
 */
function boundInstructions(content: string): string | undefined {
  let text = content;
  if (Buffer.byteLength(text, 'utf-8') > MAX_GROUP_CONFIG_BYTES) {
    const buf = Buffer.from(text, 'utf-8').subarray(0, MAX_GROUP_CONFIG_BYTES);
    // The slice may end mid-codepoint; trim a trailing replacement char.
    text = buf.toString('utf-8').replace(/�+$/, '') + '\n[… group config truncated]';
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface ResolveGroupInstructionsParams {
  /** Operator local-instruction directory (the existing fallback source). */
  groupConfigDir?: string;
  /** Feature flag: when false/undefined, server fetch is skipped entirely. */
  serverMd?: boolean;
  apiUrl: string;
  botToken: string;
  /** Full channelId (may be a `<groupNo>____<shortId>` thread composite). */
  channelId: string;
  /** Server GROUP.md cache. Omitted (or flag off) → pure local file. */
  cache?: GroupMdCache;
  signal?: AbortSignal;
}

export async function resolveGroupInstructions(
  params: ResolveGroupInstructionsParams,
): Promise<string | undefined> {
  const { groupConfigDir, serverMd, apiUrl, botToken, channelId, cache, signal } = params;

  const local = (): string | undefined => loadGroupConfig(groupConfigDir, channelId);

  // Flag off (or no cache to dedupe fetches) → pure local file, unchanged behavior.
  if (!serverMd || !cache) return local();

  const groupNo = extractParentGroupNo(channelId);

  // a) cached server GROUP.md wins (kept stable until invalidated by the
  //    event-driven refresh — a separate work item).
  const cached = cache.get(groupNo);
  if (cached) {
    const bounded = boundInstructions(cached.content);
    if (bounded) return bounded;
    // Cached-but-empty (shouldn't normally happen) → fall through to local.
    return local();
  }

  // b) server-first fetch.
  try {
    const md = await getGroupMd({ apiUrl, botToken, groupNo, signal });
    const bounded = boundInstructions(md?.content ?? '');
    if (bounded) {
      const entry: GroupMdEntry = {
        content: md.content,
        version: typeof md.version === 'number' ? md.version : 0,
        updated_at: md.updated_at ?? null,
        updated_by: md.updated_by,
      };
      cache.set(groupNo, entry);
      return bounded;
    }
    // Server reachable but no/empty GROUP.md → local fallback.
    return local();
  } catch (err) {
    // c) 404 / network / timeout — never-lose local fallback.
    console.error(
      `[cc-channel-octo] group-md: server fetch for ${groupNo} failed, falling back to local: ${String(err)}`,
    );
    return local();
  }
}

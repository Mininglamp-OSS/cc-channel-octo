// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
//   - constants.ts (THREAD_ID_SEPARATOR)
//   - group-md.ts (extractParentGroupNo / extractThreadShortId / isThreadChannelId)

/**
 * CommunityTopic (thread) channel-id helpers.
 *
 * Octo encodes a thread's channel_id as `<groupNo>____<shortId>` — the parent
 * group number, four underscores, then the thread short id. A plain group's
 * channel_id has no separator. These pure functions are the single place that
 * knows the composite format, so callers that need the parent group number
 * (e.g. roster / @-mention lookups that must hit `/groups/{groupNo}/members`)
 * or the thread short id never re-implement the split and drift apart.
 *
 * Splitting always uses the FIRST `____` occurrence (`indexOf`), so a shortId
 * that itself contains the separator stays intact on the right-hand side.
 */

/**
 * Separator between parent group_no and thread short_id in Octo's
 * CommunityTopic channel-id format (`<groupNo>____<shortId>`, 4 underscores).
 */
export const THREAD_ID_SEPARATOR = "____";

/**
 * Extract the parent group number from a channelId.
 * Thread channelId format: "groupNo____shortId" → "groupNo".
 * Group channelId format: "groupNo" → "groupNo" (returned unchanged).
 */
export function extractParentGroupNo(channelId: string): string {
  const sep = channelId.indexOf(THREAD_ID_SEPARATOR);
  return sep >= 0 ? channelId.slice(0, sep) : channelId;
}

/**
 * Extract the thread shortId from a channelId.
 * Only thread channelIds contain a shortId; group channelIds return null.
 *
 * Edge case: if channelId ends with "____" (no shortId portion), returns null.
 * Callers that require a non-empty shortId should check for falsy values.
 */
export function extractThreadShortId(channelId: string): string | null {
  const sep = channelId.indexOf(THREAD_ID_SEPARATOR);
  if (sep < 0) return null;
  const id = channelId.slice(sep + THREAD_ID_SEPARATOR.length);
  return id || null;
}

/**
 * Check if a channelId is a thread (CommunityTopic) composite id.
 */
export function isThreadChannelId(channelId: string): boolean {
  return channelId.includes(THREAD_ID_SEPARATOR);
}

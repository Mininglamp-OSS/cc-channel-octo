/**
 * GROUP.md server-event classification (P2-B) — event-driven cache refresh.
 *
 * The server emits system events on the inbound socket as `payload.event`
 * (shape `{ type, version, updated_by, group_no, short_id }`, see
 * octo/types.ts MessagePayload.event). When the operator edits a group's
 * server GROUP.md, the server reports it as one of these events; on receipt we
 * INVALIDATE the in-memory GROUP.md cache for that group so the next turn
 * re-fetches the authoritative copy (see group-md-cache.ts `invalidate`).
 *
 * SECURITY — why invalidate-then-refetch, never trust the event payload:
 *   The event arrives over the same untrusted channel as chat, so a forged
 *   `group_md_updated` event must NOT be able to inject content. We never read
 *   the new GROUP.md from the event body; we only use it as a signal to drop
 *   the cached entry, after which the resolver re-fetches over the
 *   authenticated bot token against the SSRF-validated apiUrl (the sole trusted
 *   path, identical to P2-A). The worst a forged event can do is force a
 *   redundant authenticated re-fetch of the real value — never poisoning.
 *
 * ⚠️ PROVISIONAL EVENT TYPE — the exact `event.type` literal the server emits
 * for a GROUP.md change is NOT yet confirmed from a real captured event
 * (XIN-173 confirmed the event SHAPE, not the type literal). The default below
 * is named after the design (`group_md_updated`) and is overridable via
 * `config.serverMdEventTypes`, so the literal can be calibrated against a real
 * event WITHOUT a code change once captured. Keep this note until calibrated.
 */

/**
 * Provisional `event.type` literals treated as a GROUP.md change. PROVISIONAL —
 * see the calibration note above. Overridable via `config.serverMdEventTypes`.
 *
 * Both an UPDATE and a DELETE of the server GROUP.md drive the same action —
 * INVALIDATE the cached entry so the next turn re-fetches (an updated entry is
 * re-read; a deleted one 404s and cleanly degrades to the local fallback), so
 * `group_md_deleted` sits alongside `group_md_updated` here (P3-2 deleted tail).
 */
export const DEFAULT_GROUP_MD_EVENT_TYPES: readonly string[] = [
  'group_md_updated',
  'group_md_deleted',
];

/** The `payload.event` shape (mirrors MessagePayload.event in octo/types.ts). */
export interface GroupMdEventLike {
  type?: string;
  group_no?: string;
}

/**
 * True iff this event signals a GROUP.md change (update or delete) and should
 * drive a cache refresh. All other system events (group join/leave, etc.) return
 * false and are dropped unchanged by the router. `eventTypes` lets the operator
 * override the provisional literal(s) without a code change.
 */
export function isGroupMdUpdateEvent(
  event: GroupMdEventLike | undefined,
  eventTypes: readonly string[] = DEFAULT_GROUP_MD_EVENT_TYPES,
): boolean {
  if (!event || typeof event.type !== 'string' || event.type === '') return false;
  return eventTypes.includes(event.type);
}

/**
 * Provisional `event.type` literals treated as a THREAD.md change (P3-2). Same
 * PROVISIONAL status as the group literals above — the exact wire literal is not
 * yet confirmed from a captured event, so it is named after the design and is
 * overridable via `config.threadMdEventTypes` without a code change. As on the
 * group side, both update and delete map to the same invalidate action.
 */
export const DEFAULT_THREAD_MD_EVENT_TYPES: readonly string[] = [
  'thread_md_updated',
  'thread_md_deleted',
];

/**
 * The `payload.event` shape for a THREAD.md change — like {@link GroupMdEventLike}
 * but also carrying `short_id`, which locates the subarea whose composite-keyed
 * (`groupNo::shortId`) cache entry to invalidate. `short_id` is already part of
 * MessagePayload.event (octo/types.ts).
 */
export interface ThreadMdEventLike {
  type?: string;
  group_no?: string;
  short_id?: string;
}

/**
 * True iff this event signals a THREAD.md change (update or delete). The literal
 * sets for group vs thread are DISJOINT (`group_md_*` vs `thread_md_*`), so a
 * thread event never trips the group invalidation and vice versa — the two
 * classifiers stay mutually exclusive, matching the read/write mutual-exclusion
 * contract of #88 P3.
 */
export function isThreadMdUpdateEvent(
  event: ThreadMdEventLike | undefined,
  eventTypes: readonly string[] = DEFAULT_THREAD_MD_EVENT_TYPES,
): boolean {
  if (!event || typeof event.type !== 'string' || event.type === '') return false;
  return eventTypes.includes(event.type);
}

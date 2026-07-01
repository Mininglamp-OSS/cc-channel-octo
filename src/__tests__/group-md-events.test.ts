/**
 * GROUP.md / THREAD.md event classifiers (group-md-events.ts).
 *
 * Unit-level coverage of the pure predicates + their default literal sets,
 * complementing the router-level invalidation tests in session-router.test.ts:
 *   - both update and delete literals classify as a change (P2-B + P3-2 tail);
 *   - the group and thread literal sets are DISJOINT (mutual exclusion);
 *   - overrides replace the defaults; empty/missing type never matches.
 */

import { describe, it, expect } from 'vitest';
import {
  isGroupMdUpdateEvent,
  isThreadMdUpdateEvent,
  DEFAULT_GROUP_MD_EVENT_TYPES,
  DEFAULT_THREAD_MD_EVENT_TYPES,
} from '../group-md-events.js';

describe('isGroupMdUpdateEvent', () => {
  it('matches both the update and delete default literals', () => {
    expect(isGroupMdUpdateEvent({ type: 'group_md_updated' })).toBe(true);
    expect(isGroupMdUpdateEvent({ type: 'group_md_deleted' })).toBe(true);
  });

  it('does not match thread literals or unrelated system events', () => {
    expect(isGroupMdUpdateEvent({ type: 'thread_md_updated' })).toBe(false);
    expect(isGroupMdUpdateEvent({ type: 'group_member_join' })).toBe(false);
  });

  it('never matches an undefined / empty / typeless event', () => {
    expect(isGroupMdUpdateEvent(undefined)).toBe(false);
    expect(isGroupMdUpdateEvent({})).toBe(false);
    expect(isGroupMdUpdateEvent({ type: '' })).toBe(false);
  });

  it('honours an override literal set (calibration seam)', () => {
    expect(isGroupMdUpdateEvent({ type: 'group_md_updated' }, ['group.md.changed'])).toBe(false);
    expect(isGroupMdUpdateEvent({ type: 'group.md.changed' }, ['group.md.changed'])).toBe(true);
  });
});

describe('isThreadMdUpdateEvent', () => {
  it('matches both the update and delete default literals', () => {
    expect(isThreadMdUpdateEvent({ type: 'thread_md_updated' })).toBe(true);
    expect(isThreadMdUpdateEvent({ type: 'thread_md_deleted' })).toBe(true);
  });

  it('does not match group literals or unrelated system events', () => {
    expect(isThreadMdUpdateEvent({ type: 'group_md_updated' })).toBe(false);
    expect(isThreadMdUpdateEvent({ type: 'group_md_deleted' })).toBe(false);
    expect(isThreadMdUpdateEvent({ type: 'group_member_join' })).toBe(false);
  });

  it('never matches an undefined / empty / typeless event', () => {
    expect(isThreadMdUpdateEvent(undefined)).toBe(false);
    expect(isThreadMdUpdateEvent({})).toBe(false);
    expect(isThreadMdUpdateEvent({ type: '' })).toBe(false);
  });

  it('honours an override literal set (calibration seam)', () => {
    expect(isThreadMdUpdateEvent({ type: 'thread_md_updated' }, ['thread.md.changed'])).toBe(false);
    expect(isThreadMdUpdateEvent({ type: 'thread.md.changed' }, ['thread.md.changed'])).toBe(true);
  });
});

describe('default literal sets are disjoint (mutual exclusion invariant)', () => {
  it('no literal appears in both the group and thread default sets', () => {
    const overlap = DEFAULT_GROUP_MD_EVENT_TYPES.filter((t) => DEFAULT_THREAD_MD_EVENT_TYPES.includes(t));
    expect(overlap).toEqual([]);
  });
});

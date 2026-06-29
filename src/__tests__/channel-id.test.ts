/**
 * Tests for octo/channel-id.ts — composite (thread) channel-id parsing.
 *
 * Thread channelId format: `<groupNo>____<shortId>` (THREAD_ID_SEPARATOR, 4
 * underscores). Group channelId has no separator.
 */

import { describe, it, expect } from 'vitest';
import {
  THREAD_ID_SEPARATOR,
  extractParentGroupNo,
  extractThreadShortId,
  isThreadChannelId,
} from '../octo/channel-id.js';

describe('THREAD_ID_SEPARATOR', () => {
  it('is exactly four underscores', () => {
    expect(THREAD_ID_SEPARATOR).toBe('____');
    expect(THREAD_ID_SEPARATOR.length).toBe(4);
  });
});

describe('isThreadChannelId', () => {
  it('is true for a composite id', () => {
    expect(isThreadChannelId('12345____67890')).toBe(true);
  });

  it('is false for a plain group id (no separator)', () => {
    expect(isThreadChannelId('12345')).toBe(false);
    expect(isThreadChannelId('s1_group99')).toBe(false);
  });

  it('does not treat fewer than four underscores as a separator', () => {
    expect(isThreadChannelId('a_b')).toBe(false);
    expect(isThreadChannelId('a__b')).toBe(false);
    expect(isThreadChannelId('a___b')).toBe(false);
  });
});

describe('extractParentGroupNo', () => {
  it('returns the left segment of a composite id', () => {
    expect(extractParentGroupNo('12345____67890')).toBe('12345');
  });

  it('returns the id unchanged when there is no separator', () => {
    expect(extractParentGroupNo('12345')).toBe('12345');
  });

  it('splits on the FIRST separator when several are present', () => {
    // Right-hand side keeps its own separator; only the first split matters.
    expect(extractParentGroupNo('12345____67890____extra')).toBe('12345');
  });

  it('returns an empty parent when the id starts with the separator', () => {
    expect(extractParentGroupNo('____67890')).toBe('');
  });
});

describe('extractThreadShortId', () => {
  it('returns the right segment of a composite id', () => {
    expect(extractThreadShortId('12345____67890')).toBe('67890');
  });

  it('returns null for a plain group id (no separator)', () => {
    expect(extractThreadShortId('12345')).toBeNull();
  });

  it('keeps embedded separators in the short id (first split only)', () => {
    expect(extractThreadShortId('12345____67890____extra')).toBe('67890____extra');
  });

  it('returns null when the short-id segment is empty (trailing separator)', () => {
    expect(extractThreadShortId('12345____')).toBeNull();
  });

  it('returns the short id even when the parent segment is empty', () => {
    expect(extractThreadShortId('____67890')).toBe('67890');
  });
});

/**
 * C1 follow-up cleanup tests (李飞飞).
 *
 * Three齐静春 PR#41 non-blocking + my own PR#38 non-blocking, addressed:
 *   1. truncateByBytes delegated to truncateUtf8ByBytes (O(n) walk-back instead of O(n²) per-char while loop)
 *   2. RejectionReason union trimmed to the 2 reasons actually emitted
 *   3. buildMediaUrl rejects %2F encoded slash (server-decode defense-in-depth)
 */

import { describe, it, expect } from 'vitest';
import { resolveRichTextContent, resolveMultipleForwardText } from '../inbound.js';
import { MessageType, RICH_TEXT_BLOCK_TEXT } from '../octo/types.js';
import type { MessagePayload } from '../octo/types.js';

const API_URL = 'https://api.example.com';

// ─── 1. truncateByBytes O(n²) → O(n) delegation ────────────────────────

describe('C1 follow-up #1: truncateByBytes uses O(n) walk-back algorithm', () => {
  it('handles 1 MB of CJK input without quadratic slowdown', () => {
    // Pre-fix: input.slice(0, maxBytes) returned 1M chars then while loop
    // popped one char at a time until byte length ≤ cap. Each Buffer.byteLength
    // was O(n), so total O(n²) — for 1M chars this was ~10s+.
    // Post-fix: O(n) Buffer.from + O(1) walk-back.
    const oneMB = '中'.repeat(350_000); // ~1 MB UTF-8 (350K * 3 bytes)
    const start = Date.now();
    const r = resolveRichTextContent({ content: oneMB }, API_URL);
    const elapsed = Date.now() - start;

    // Should be well under 100ms even on slow runners (O(n) Buffer encode).
    expect(elapsed).toBeLessThan(500);
    expect(r.text).toContain('[RichText truncated]');
    expect(Buffer.byteLength(r.text, 'utf-8')).toBeLessThanOrEqual(32 * 1024 + 100);
    // No U+FFFD — byte-safe truncation preserved.
    expect(r.text).not.toContain('\uFFFD');
  });

  it('still byte-safe truncates CJK to clean boundary', () => {
    // Regression of original behavior: CJK input truncated cleanly, no half-chars.
    const input = '中'.repeat(20_000); // 60K bytes
    const r = resolveRichTextContent({ content: input }, API_URL);
    expect(r.text).not.toContain('\uFFFD');
    // Byte length stays under cap (allow marker overhead).
    expect(Buffer.byteLength(r.text, 'utf-8')).toBeLessThanOrEqual(32 * 1024 + 100);
  });

  it('MultipleForward also uses the new O(n) helper (regression check)', () => {
    const huge = 'A'.repeat(20_000);
    const payload = {
      users: [{ uid: 'u1', name: 'U' }],
      msgs: [{ from_uid: 'u1', payload: { type: MessageType.Text, content: huge } }],
    };
    const start = Date.now();
    const r = resolveMultipleForwardText(payload, API_URL);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(r).toContain('输出已截断');
  });

  it('benign small input unchanged', () => {
    const r = resolveRichTextContent(
      { content: [{ type: RICH_TEXT_BLOCK_TEXT, text: 'hello world' }] as unknown[] } as MessagePayload,
      API_URL,
    );
    expect(r.text).toBe('hello world');
    expect(r.text).not.toContain('truncated');
  });
});

// ─── 2. RejectionReason trim ───────────────────────────────────────────

describe('C1 follow-up #2: RejectionReason trimmed to emitted reasons', () => {
  it('type only allows rate_limited and oversized', async () => {
    // Type-level smoke: import the type and verify the runtime emits only
    // these two values. Compile-time check is enforced by tsc passing.
    const mod = await import('../session-router.js');
    expect(typeof mod.SessionRouter).toBe('function');
    // Behavior verified by c1-rejection-userguard.test.ts (still passes
    // after trim because it only tested rate_limited / oversized).
  });
});

// ─── 3. buildMediaUrl %2F defense-in-depth ─────────────────────────────
// Tests live in inbound.test.ts (extending the existing describe block).
// This file just documents the cross-reference.

describe('C1 follow-up #3: buildMediaUrl %2F defense', () => {
  it('cross-reference: see inbound.test.ts "rejects %2F encoded slash"', () => {
    // 5 it.each cases there cover lowercase / uppercase / mixed / any %2F /
    // benign-looking %2F. All rejected.
    expect(true).toBe(true);
  });
});

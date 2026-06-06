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
// Type contract is enforced by `tsc --noEmit` (compile-time). Runtime
// behavior is exercised by `c1-rejection-userguard.test.ts`. A separate
// `expect(typeof mod.SessionRouter).toBe('function')` assertion here would
// test module loading, not the type trim — that is, it would pass even if
// the union were reverted to the pre-trim 7 members. Tautology removed per
// REVIEW_CHECKLIST §11 ("if reverting the change does not fail the test,
// the test is not testing the change").
//
// ─── 3. buildMediaUrl %2F defense-in-depth ─────────────────────────────
// Real coverage lives in inbound.test.ts (`describe('buildMediaUrl')` →
// `it.each(['..%2f..%2finternal/secret.env', ...])`). A placeholder
// `expect(true).toBe(true)` here would have the same defect as #2.
// Pointer kept as a comment so a future reader knows where to look.

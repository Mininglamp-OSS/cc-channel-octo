/**
 * #105: formatToolParams — tool-progress param rendering.
 *
 * Verifies the compact, truncated one-liner used in "🔧 Running <tool>(<params>)"
 * notices: object→"k: v" flattening, string passthrough, whitespace collapse,
 * length cap, and the empty/edge cases that fall back to a bare tool name.
 */
import { describe, it, expect } from 'vitest';
import { formatToolParams, MAX_TOOL_PARAM_CHARS } from '../index.js';

describe('formatToolParams (#105)', () => {
  it('renders object primitive fields as "k: v, k: v"', () => {
    expect(formatToolParams({ command: 'octo-cli group list' })).toBe('command: octo-cli group list');
    expect(formatToolParams({ file_path: '/a/b.ts', limit: 50 })).toBe('file_path: /a/b.ts, limit: 50');
  });

  it('passes a string input through', () => {
    expect(formatToolParams('hello world')).toBe('hello world');
  });

  it('skips nested objects / null fields, keeps primitives', () => {
    expect(formatToolParams({ a: 1, nested: { x: 1 }, b: 'y', n: null })).toBe('a: 1, b: y');
  });

  it('falls back to JSON when an object has no primitive fields', () => {
    expect(formatToolParams({ only: { nested: true } })).toBe('{"only":{"nested":true}}');
  });

  it('collapses whitespace/newlines to a single line', () => {
    expect(formatToolParams({ command: 'line1\n  line2\t end' })).toBe('command: line1 line2 end');
  });

  it('truncates to MAX_TOOL_PARAM_CHARS with an ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = formatToolParams({ command: long });
    expect(out.length).toBe(MAX_TOOL_PARAM_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns "" for null/undefined (caller renders bare tool name)', () => {
    expect(formatToolParams(undefined)).toBe('');
    expect(formatToolParams(null)).toBe('');
  });

  it('returns "" for an empty object and empty string', () => {
    expect(formatToolParams({})).toBe('');
    expect(formatToolParams('   ')).toBe('');
  });

  it('does not throw on a circular object (safeJson fallback)', () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ; // nested object → skipped; no primitives → JSON → circular → ''
    expect(() => formatToolParams(circ)).not.toThrow();
    expect(formatToolParams(circ)).toBe('');
  });
});

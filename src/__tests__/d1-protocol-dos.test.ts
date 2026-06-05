/**
 * D1 (Wave 2) tests:
 *  - S6 socket.ts tempBuffer OOM guard + variable-length 4-byte cap
 *  - S7 api.ts getChannelMessages base64 payload size + array length caps
 *  - P1-3 agent-bridge.ts buildSystemPrompt 100 KiB cap with truncation
 *  - P1-4 agent-bridge.ts SDK output null-safety guard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../agent-bridge.js';

// ─── P1-3: buildSystemPrompt length cap ───────────────────────────────────────

describe('buildSystemPrompt MAX_SYSTEM_PROMPT_CHARS (D1/P1-3)', () => {
  it('returns assembled prompt unchanged when under cap', () => {
    const out = buildSystemPrompt('history line', 'group chat', 'custom prompt');
    expect(out.length).toBeLessThan(2_000);
    expect(out).toContain('custom prompt');
    expect(out).toContain('[Group context]\ngroup chat');
    expect(out).toContain('[Conversation history]\nhistory line');
  });

  it('caps total length at 100 KiB when history is huge', () => {
    // 40 turns × 4 KiB each = 160 KiB worth of history.
    const turns: string[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push(`[user]: turn ${i} ${'x'.repeat(4_000)}`);
    }
    const huge = turns.join('\n');
    const out = buildSystemPrompt(huge, '', '');
    // 100 KiB hard ceiling plus a small slack for headers/labels.
    expect(out.length).toBeLessThanOrEqual(110 * 1024);
    expect(out).toContain('[older turns dropped]');
    // Tail must be preserved (most recent turn = turn 39).
    expect(out).toContain('turn 39');
    // Oldest turn should be dropped.
    expect(out).not.toContain('turn 0 ');
  });

  it('preserves security prefix and custom prompt verbatim when truncating', () => {
    const huge = '[user]: ' + 'a'.repeat(120 * 1024);
    const out = buildSystemPrompt(huge, '', 'OPERATOR_DIRECTIVE_42');
    // The non-truncatable sections must survive.
    expect(out).toContain('OPERATOR_DIRECTIVE_42');
    expect(out).toContain('coding assistant'); // security prefix excerpt
  });

  it('caps group context separately when total exceeds the budget', () => {
    // Push total over 100 KiB so the cap kicks in.
    const giantGroup = 'msg\n'.repeat(8_000);  // ~32 KB — group is big
    const giantHistory = '[user]: x'.repeat(20_000); // ~200 KB — forces truncation
    const out = buildSystemPrompt(giantHistory, giantGroup, '');
    expect(out.length).toBeLessThanOrEqual(110 * 1024);
    // Group context budget is 20 KiB — should still appear, but drop oldest.
    expect(out).toContain('[Group context]');
    expect(out).toContain('[older messages dropped]');
  });

  it('drops history entirely if security + custom + group already saturate budget', () => {
    const giantCustom = 'OP_'.repeat(40_000); // 120 KB custom prompt
    const out = buildSystemPrompt('history line', 'group chat', giantCustom);
    // Custom prompt is non-truncatable; we still produce a result.
    expect(out).toContain(giantCustom);
    expect(out.length).toBeGreaterThan(115 * 1024); // custom dominates
    // The trailing [Conversation history] section (the appended one, not the
    // literal mention inside the security prefix) should be truncated to a
    // tiny tail since budget is exhausted.
    const lastHistIdx = out.lastIndexOf('[Conversation history]');
    const histTail = out.substring(lastHistIdx);
    expect(histTail.length).toBeLessThan(5 * 1024);
  });
});

// ─── P1-4: queryAgent SDK output null-safety ─────────────────────────────────

describe('queryAgent assistant.message null-safety (D1/P1-4)', () => {
  it('does not throw when SDK yields assistant message with undefined content', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant', message: {} };       // .content missing
          yield { type: 'assistant', message: { content: undefined } }; // .content undefined
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
          yield { type: 'result', subtype: 'success' };
        },
        close: vi.fn(),
      }),
    }));
    const { queryAgent } = await import('../agent-bridge.js');
    const out: string[] = [];
    for await (const chunk of queryAgent('hi', '', '', {
      cwd: '/tmp',
      sdk: {
        permissionMode: 'bypassPermissions',
        settingSources: ['user'],
        allowedTools: [],
      },
    } as never)) {
      out.push(chunk);
    }
    expect(out.join('')).toBe('ok');
  });

  it('does not throw when assistant message lacks message field entirely', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'assistant' };                    // .message missing entirely
          yield { type: 'result', subtype: 'success' };
        },
        close: vi.fn(),
      }),
    }));
    const { queryAgent } = await import('../agent-bridge.js');
    const out: string[] = [];
    for await (const chunk of queryAgent('hi', '', '', {
      cwd: '/tmp',
      sdk: {
        permissionMode: 'bypassPermissions',
        settingSources: ['user'],
        allowedTools: [],
      },
    } as never)) {
      out.push(chunk);
    }
    expect(out).toEqual([]);
  });
});

// ─── S7: getChannelMessages payload + count caps ─────────────────────────────

describe('getChannelMessages defensive caps (D1/S7)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('drops oversized base64 payload instead of decoding to a 75 MB Buffer', async () => {
    // Construct a server response with one message carrying a > 256 KiB
    // base64 payload. The pre-fix path would call Buffer.from on it.
    const oversized = 'A'.repeat(300 * 1024);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            messages: [
              { from_uid: 'u1', timestamp: 1, payload: oversized },
            ],
          }),
        ),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getChannelMessages } = await import('../octo/api.js');
    const out = await getChannelMessages({
      apiUrl: 'https://api',
      botToken: 't',
      channelId: 'ch',
      channelType: 2,
    });
    expect(out).toHaveLength(1);
    expect(out[0].payload).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping oversized payload'),
    );
    warnSpy.mockRestore();
  });

  it('caps returned messages at requested limit even when server returns more', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      from_uid: `u${i}`,
      timestamp: i,
      content: `m${i}`,
    }));
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ messages: items })),
    });

    const { getChannelMessages } = await import('../octo/api.js');
    const out = await getChannelMessages({
      apiUrl: 'https://api',
      botToken: 't',
      channelId: 'ch',
      channelType: 2,
      limit: 10,
    });
    expect(out).toHaveLength(10);
    expect(out[0].from_uid).toBe('u0');
    expect(out[9].from_uid).toBe('u9');
  });

  it('still decodes well-sized payloads successfully', async () => {
    const json = JSON.stringify({ type: 1, content: 'hello' });
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            messages: [{ from_uid: 'u1', timestamp: 1, payload: b64 }],
          }),
        ),
    });

    const { getChannelMessages } = await import('../octo/api.js');
    const out = await getChannelMessages({
      apiUrl: 'https://api',
      botToken: 't',
      channelId: 'ch',
      channelType: 2,
    });
    expect(out).toHaveLength(1);
    expect(out[0].payload).toEqual({ type: 1, content: 'hello' });
  });
});

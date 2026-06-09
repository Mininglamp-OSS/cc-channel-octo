/**
 * D1 (Wave 2) tests:
 *  - S6 socket.ts tempBuffer OOM guard + variable-length 4-byte cap
 *  - S7 api.ts getChannelMessages base64 payload size + array length caps
 *  - P1-3 agent-bridge.ts buildSystemPrompt flat cap (frozen prompt)
 *  - P1-4 agent-bridge.ts SDK output null-safety guard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSystemPrompt } from '../agent-bridge.js';

// ─── P1-3: buildSystemPrompt length cap (frozen: operator content only) ───────

describe('buildSystemPrompt MAX_SYSTEM_PROMPT_CHARS (D1/P1-3)', () => {
  it('returns assembled prompt unchanged when under cap', () => {
    const out = buildSystemPrompt('custom prompt', 'group rules');
    // The frozen prompt is just security prefix + custom + group instructions —
    // a few KiB, well under the 100 KiB safety cap.
    expect(out.length).toBeLessThan(5_000);
    expect(out).toContain('custom prompt');
    expect(out).toContain('[Group instructions]\ngroup rules');
    // Frozen: history/group context are NOT here anymore.
    expect(out).not.toContain('\n[Group context]\n');
    expect(out).not.toContain('\n[Conversation history]\n');
  });

  it('flat-caps at 100 KiB when an operator config (SOUL/GROUP.md) is pathologically large', () => {
    const giantCustom = 'OP_'.repeat(60_000); // ~180 KB custom prompt
    const out = buildSystemPrompt(giantCustom);
    expect(out.length).toBeLessThanOrEqual(100 * 1024);
    // Security prefix is first and survives (it leads the assembled string).
    expect(out).toContain('coding assistant');
  });

  it('preserves security prefix verbatim under the cap', () => {
    const out = buildSystemPrompt('OPERATOR_DIRECTIVE_42', 'rules');
    expect(out).toContain('OPERATOR_DIRECTIVE_42');
    expect(out).toContain('coding assistant'); // security prefix excerpt
    expect(out).toContain('rules');
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
    for await (const chunk of queryAgent('hi', {
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
    for await (const chunk of queryAgent('hi', {
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

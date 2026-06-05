/**
 * getChannelMessages (G4) — API history backfill.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('getChannelMessages (G4)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed messages with decoded payload', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    const samplePayload = { type: 1, content: 'hello world' };
    const payloadB64 = Buffer.from(JSON.stringify(samplePayload), 'utf-8').toString('base64');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            messages: [
              {
                from_uid: 'user1',
                from_name: 'Alice',
                content: 'hello world',
                timestamp: 1234567890,
                message_id: 'm1',
                message_seq: 5,
                type: 1,
                payload: payloadB64,
              },
            ],
          }),
        ),
    } as unknown as Response);

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].from_uid).toBe('user1');
    expect(result[0].from_name).toBe('Alice');
    expect(result[0].content).toBe('hello world');
    expect(result[0].message_seq).toBe(5);
    expect(result[0].type).toBe(1);
    expect(result[0].payload).toEqual(samplePayload);
  });

  it('handles missing payload field gracefully', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            messages: [
              { from_uid: 'user1', content: 'no payload', timestamp: 1, message_seq: 1, type: 1 },
            ],
          }),
        ),
    } as unknown as Response);

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    expect(result).toHaveLength(1);
    expect(result[0].payload).toBeUndefined();
  });

  it('handles malformed payload gracefully (does not throw)', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            messages: [
              { from_uid: 'user1', payload: 'not-valid-base64-or-json', timestamp: 1, type: 1 },
            ],
          }),
        ),
    } as unknown as Response);

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    expect(result).toHaveLength(1);
    expect(result[0].payload).toBeUndefined(); // decoding failed, but no crash
  });

  it('returns empty array on HTTP error', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('server error'),
    } as unknown as Response);

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    expect(result).toEqual([]);
  });

  it('returns empty array on network error (no throw)', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    expect(result).toEqual([]);
  });

  it('returns empty array when messages field absent', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
    } as unknown as Response);

    const result = await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    expect(result).toEqual([]);
  });

  it('sends correct request body (sync endpoint)', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"messages":[]}'),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'group-123',
      channelType: 2,
      limit: 50,
      startMessageSeq: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/bot/messages/sync');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.channel_id).toBe('group-123');
    expect(body.channel_type).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.start_message_seq).toBe(100);
    expect(body.pull_mode).toBe(1);
  });

  it('defaults limit to 20 when not specified', async () => {
    const { getChannelMessages } = await import('../octo/api.js');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"messages":[]}'),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    await getChannelMessages({
      apiUrl: 'https://api.example.com',
      botToken: 'tok',
      channelId: 'g1',
      channelType: 2,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.limit).toBe(20);
  });
});

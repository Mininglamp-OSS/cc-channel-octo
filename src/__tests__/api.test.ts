/**
 * Tests for octo/api.ts — G24 sendMediaMessage / sendRichTextMessage / getUploadCredentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelType, MessageType, RICH_TEXT_BLOCK_TEXT, RICH_TEXT_BLOCK_IMAGE } from '../octo/types.js';
import type { RichTextBlock } from '../octo/types.js';
import {
  sendMediaMessage,
  sendRichTextMessage,
  getUploadCredentials,
} from '../octo/api.js';

// Mock global fetch
const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function mockJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockErrorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: 'Error' });
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});
import { afterAll } from 'vitest';

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const CH = { channelId: 'ch1', channelType: ChannelType.Group };

describe('sendMediaMessage', () => {
  it('Image: includes width, height, name, size in payload', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendMediaMessage({
      ...BASE, ...CH,
      type: MessageType.Image,
      url: 'https://cdn/img.png',
      width: 100, height: 200, name: 'img.png', size: 1024,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.type).toBe(MessageType.Image);
    expect(body.payload.url).toBe('https://cdn/img.png');
    expect(body.payload.width).toBe(100);
    expect(body.payload.height).toBe(200);
    expect(body.payload.name).toBe('img.png');
    expect(body.payload.size).toBe(1024);
  });

  it('File: includes name and size only, no width/height', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendMediaMessage({
      ...BASE, ...CH,
      type: MessageType.File,
      url: 'https://cdn/doc.pdf',
      name: 'doc.pdf', size: 2048,
      width: 999, height: 999, // should NOT be in payload for File
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.type).toBe(MessageType.File);
    expect(body.payload.name).toBe('doc.pdf');
    expect(body.payload.size).toBe(2048);
    expect(body.payload.width).toBeUndefined();
    expect(body.payload.height).toBeUndefined();
  });

  it('includes mention payload when mentionUids provided', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendMediaMessage({
      ...BASE, ...CH,
      type: MessageType.Image,
      url: 'https://cdn/img.png',
      mentionUids: ['u1', 'u2'],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.mention.uids).toEqual(['u1', 'u2']);
  });

  it('uses /v1/bot/sendMessage endpoint', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendMediaMessage({
      ...BASE, ...CH,
      type: MessageType.Image,
      url: 'https://cdn/img.png',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://test.example.com/v1/bot/sendMessage');
  });
});

describe('sendRichTextMessage', () => {
  it('sends type=14 with blocks array', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    const blocks: RichTextBlock[] = [
      { type: RICH_TEXT_BLOCK_TEXT, text: 'Hello' },
      { type: RICH_TEXT_BLOCK_IMAGE, url: 'https://cdn/img.png', width: 100, height: 50 },
      { type: RICH_TEXT_BLOCK_TEXT, text: ' world' },
    ];
    await sendRichTextMessage({ ...BASE, ...CH, blocks });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.type).toBe(MessageType.RichText);
    expect(body.payload.content).toEqual(blocks);
  });

  it('includes plain field when provided', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendRichTextMessage({
      ...BASE, ...CH,
      blocks: [{ type: RICH_TEXT_BLOCK_TEXT, text: 'hi' }],
      plain: 'hi [图片]',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.plain).toBe('hi [图片]');
  });

  it('sets mention.all = 1 when mentionAll is true', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendRichTextMessage({
      ...BASE, ...CH,
      blocks: [{ type: RICH_TEXT_BLOCK_TEXT, text: '@all hi' }],
      mentionAll: true,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.mention.all).toBe(1);
  });

  it('omits plain field when not provided', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }));

    await sendRichTextMessage({
      ...BASE, ...CH,
      blocks: [{ type: RICH_TEXT_BLOCK_TEXT, text: 'hi' }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.payload.plain).toBeUndefined();
  });
});

describe('getUploadCredentials', () => {
  it('parses full credentials response', async () => {
    const mock = {
      bucket: 'my-bucket', region: 'ap-shanghai', key: 'path/to/file.png',
      credentials: {
        tmpSecretId: 'tmp-id', tmpSecretKey: 'tmp-key', sessionToken: 'tok',
      },
      startTime: 1000, expiredTime: 4600,
      cdnBaseUrl: 'https://cdn.example.com',
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(mock));

    const result = await getUploadCredentials({ ...BASE, filename: 'file.png' });
    expect(result.bucket).toBe('my-bucket');
    expect(result.credentials.tmpSecretId).toBe('tmp-id');
    expect(result.cdnBaseUrl).toBe('https://cdn.example.com');
  });

  it('URL-encodes filename in query string', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r', key: 'k',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 2,
    }));

    await getUploadCredentials({ ...BASE, filename: 'spaces in name.png' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filename=spaces%20in%20name.png');
  });

  it('throws on missing top-level field', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r',
      // key missing
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
    }));

    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/incomplete response.*key/);
  });

  it('throws on missing credentials field', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({
      bucket: 'b', region: 'r', key: 'k',
      credentials: { tmpSecretId: 'i' /* tmpSecretKey, sessionToken missing */ },
    }));

    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/incomplete credentials/);
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(403, 'Forbidden'));
    await expect(getUploadCredentials({ ...BASE, filename: 'x.png' }))
      .rejects.toThrow(/failed \(403\)/);
  });
});

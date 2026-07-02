/**
 * Tests for octo/api.ts — getUploadCredentials.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getUploadCredentials, sendReadReceipt, fetchUserInfo } from '../octo/api.js';
import { ChannelType } from '../octo/types.js';

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

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };

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

  it('sanitizes Bearer token in error body (P1 from PR#34 review)', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(
      401,
      'unauthorized: Authorization: Bearer bf_secret_token_12345',
    ));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    // Token MUST NOT appear in the surfaced error message.
    expect(captured!.message).not.toContain('bf_secret_token_12345');
    // Sanitization replacement marker present.
    expect(captured!.message).toContain('***');
  });

  it('sanitizes JSON-quoted authorization header', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(
      500,
      '{"error":"oops","authorization":"bf_secret_in_json"}',
    ));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).not.toContain('bf_secret_in_json');
    expect(captured!.message).toContain('***');
  });

  it('caps error body at 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    fetchMock.mockResolvedValueOnce(mockErrorResponse(500, longBody));
    let captured: Error | undefined;
    try {
      await getUploadCredentials({ ...BASE, filename: 'x.png' });
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeDefined();
    // Error prefix + 200 chars max + nothing more
    expect(captured!.message.length).toBeLessThan(300);
    expect(captured!.message).not.toMatch(/x{300,}/);
  });
});

describe('sendReadReceipt — message_ids guard', () => {
  const RR_BASE = {
    apiUrl: 'https://api.example.com',
    botToken: 'test-token',
    channelId: 'chan-1',
    channelType: ChannelType.DM,
  };

  function bodyOf(callIndex = 0): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return JSON.parse(init.body as string);
  }

  it('includes message_ids when non-empty', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['123', '456'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf()).toMatchObject({ message_ids: ['123', '456'] });
  });

  it('omits message_ids when the array is empty', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect('message_ids' in bodyOf()).toBe(false);
    // still clears the unread badge — channel_id is present
    expect(bodyOf()).toMatchObject({ channel_id: 'chan-1' });
  });

  it('omits message_ids when every id is empty or blank', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['', '   '] });
    expect('message_ids' in bodyOf()).toBe(false);
  });

  it('filters out blank ids and keeps the real ones', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({}));
    await sendReadReceipt({ ...RR_BASE, messageIds: ['x', '', '  '] });
    expect(bodyOf()).toMatchObject({ message_ids: ['x'] });
  });
});

describe('fetchUserInfo', () => {
  const UI_BASE = { apiUrl: 'https://api.example.com', botToken: 'tok', uid: 'u1' };

  it('returns the display name on a 200 with a name', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ uid: 'u1', name: 'Alice', avatar: 'a.png' }));
    const info = await fetchUserInfo(UI_BASE);
    expect(info).toEqual({ uid: 'u1', name: 'Alice', avatar: 'a.png' });
  });

  it('returns null (deterministic miss) on a 200 with no name', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ uid: 'u1' }));
    expect(await fetchUserInfo(UI_BASE)).toBeNull();
  });

  it('returns null (deterministic miss) on 404', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(404, 'not found'));
    expect(await fetchUserInfo(UI_BASE)).toBeNull();
  });

  it('throws (transient) on a non-404 error status so the caller only backs off briefly', async () => {
    fetchMock.mockResolvedValueOnce(mockErrorResponse(500, 'server error'));
    await expect(fetchUserInfo(UI_BASE)).rejects.toThrow();
  });

  it('throws (transient) on a network/timeout failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(fetchUserInfo(UI_BASE)).rejects.toThrow();
  });
});

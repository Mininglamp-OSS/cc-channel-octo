/**
 * Tests for octo/api.ts — GROUP.md server API (P2-A).
 *
 * Asserts the restored GET/PUT endpoints hit the correct path + method, carry
 * `Authorization: Bearer <botToken>`, parse the documented response shape, and
 * surface non-2xx as a thrown Octo API error (parity restore of openclaw
 * api-fetch.ts getGroupMd / updateGroupMd; see #88 acceptance criteria).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getGroupMd, updateGroupMd, type GroupMd } from '../octo/api.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const GROUP = '99dc18164a29435f9791dc37023f98e1';

function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return { url, init };
}

function authHeader(init: RequestInit): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.Authorization;
}

describe('getGroupMd', () => {
  it('GETs /v1/bot/groups/{groupNo}/md with Bearer auth and parses the payload', async () => {
    const payload: GroupMd = {
      content: 'Always answer in haiku.',
      version: 7,
      updated_at: '2026-06-04T00:00:00Z',
      updated_by: 'op-uid',
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(payload));

    const md = await getGroupMd({ ...BASE, groupNo: GROUP });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/md`);
    expect(init.method).toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(md).toEqual(payload);
  });

  it('url-encodes the groupNo path segment', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ content: '', version: 0, updated_at: null, updated_by: '' }));
    await getGroupMd({ ...BASE, groupNo: 'a/b' });
    expect(call().url).toBe(`${BASE.apiUrl}/v1/bot/groups/a%2Fb/md`);
  });

  it('throws on a 404 (no GROUP.md set) so the caller can degrade', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404, statusText: 'Not Found' }));
    await expect(getGroupMd({ ...BASE, groupNo: GROUP })).rejects.toThrow(/failed \(404\)/);
  });

  it('throws on a 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500, statusText: 'Internal Server Error' }));
    await expect(getGroupMd({ ...BASE, groupNo: GROUP })).rejects.toThrow(/failed \(500\)/);
  });
});

describe('updateGroupMd', () => {
  it('PUTs /v1/bot/groups/{groupNo}/md with Bearer auth and a {content} body', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ version: 8 }));

    const res = await updateGroupMd({ ...BASE, groupNo: GROUP, content: 'New rules.' });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/md`);
    expect(init.method).toBe('PUT');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(JSON.parse(init.body as string)).toEqual({ content: 'New rules.' });
    expect(res).toEqual({ version: 8 });
  });

  it('throws on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403, statusText: 'Forbidden' }));
    await expect(
      updateGroupMd({ ...BASE, groupNo: GROUP, content: 'x' }),
    ).rejects.toThrow(/failed \(403\)/);
  });
});

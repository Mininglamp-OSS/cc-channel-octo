/**
 * Tests for octo/api.ts — thread lifecycle endpoints.
 *
 * Each test asserts the restored endpoint hits the correct path + method and
 * carries `Authorization: Bearer <botToken>` (parity restore of openclaw
 * api-fetch.ts; see #88 acceptance criteria).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import {
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listThreadMembers,
  joinThread,
  leaveThread,
} from '../octo/api.js';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockEmptyResponse(status = 200): Response {
  // null body — a 204 (and other null-body statuses) rejects a non-null body.
  return new Response(null, { status, statusText: 'OK' });
}

const BASE = { apiUrl: 'https://test.example.com', botToken: 'bf_test' };
const GROUP = '99dc18164a29435f9791dc37023f98e1';
const SHORT = '2071488441815666688';

/** Pull (url, init) of the Nth fetch call. */
function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return { url, init };
}

function authHeader(init: RequestInit): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.Authorization;
}

describe('createThread', () => {
  it('POSTs to /v1/bot/groups/{groupNo}/threads with Bearer auth and name body', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ short_id: SHORT, name: 'topic', creator_uid: 'u1' }),
    );

    const out = await createThread({ ...BASE, groupNo: GROUP, name: 'topic' });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(JSON.parse(init.body as string)).toEqual({ name: 'topic' });
    expect(out).toEqual({ short_id: SHORT, name: 'topic', creator_uid: 'u1' });
  });

  it('includes source_message_id only when provided', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ short_id: SHORT, name: 'topic', creator_uid: 'u1' }),
    );
    await createThread({ ...BASE, groupNo: GROUP, name: 'topic', sourceMessageId: 42 });
    expect(JSON.parse(call().init.body as string)).toEqual({
      name: 'topic',
      source_message_id: 42,
    });
  });
});

describe('listThreads', () => {
  it('GETs the threads collection with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([{ short_id: SHORT, name: 't', creator_uid: 'u1', status: 0 }]),
    );

    const out = await listThreads({ ...BASE, groupNo: GROUP });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(out).toHaveLength(1);
    expect(out[0].short_id).toBe(SHORT);
  });

  it('tolerates a { threads: [...] } envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ threads: [{ short_id: SHORT, name: 't', creator_uid: 'u1', status: 0 }] }),
    );
    const out = await listThreads({ ...BASE, groupNo: GROUP });
    expect(out).toHaveLength(1);
  });

  it('returns [] for an unexpected shape', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ unexpected: true }));
    expect(await listThreads({ ...BASE, groupNo: GROUP })).toEqual([]);
  });
});

describe('getThread', () => {
  it('GETs a single thread by short id with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ short_id: SHORT, name: 't', creator_uid: 'u1', status: 0, member_count: 3 }),
    );

    const out = await getThread({ ...BASE, groupNo: GROUP, shortId: SHORT });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(out.member_count).toBe(3);
  });
});

describe('deleteThread', () => {
  it('DELETEs a thread by short id with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(mockEmptyResponse(204));

    await deleteThread({ ...BASE, groupNo: GROUP, shortId: SHORT });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}`);
    expect(init.method).toBe('DELETE');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
  });
});

describe('listThreadMembers', () => {
  it('GETs the thread members with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse([{ uid: 'u1', role: 1 }, { uid: 'u2', role: 0 }]),
    );

    const out = await listThreadMembers({ ...BASE, groupNo: GROUP, shortId: SHORT });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}/members`);
    expect(init.method ?? 'GET').toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ uid: 'u1', role: 1 });
  });

  it('tolerates a { members: [...] } envelope', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ members: [{ uid: 'u1', role: 1 }] }));
    const out = await listThreadMembers({ ...BASE, groupNo: GROUP, shortId: SHORT });
    expect(out).toHaveLength(1);
  });
});

describe('joinThread', () => {
  it('POSTs to .../join with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(mockEmptyResponse(200));

    await joinThread({ ...BASE, groupNo: GROUP, shortId: SHORT });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}/join`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
  });
});

describe('leaveThread', () => {
  it('POSTs to .../leave with Bearer auth', async () => {
    fetchMock.mockResolvedValueOnce(mockEmptyResponse(200));

    await leaveThread({ ...BASE, groupNo: GROUP, shortId: SHORT });

    const { url, init } = call();
    expect(url).toBe(`${BASE.apiUrl}/v1/bot/groups/${GROUP}/threads/${SHORT}/leave`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${BASE.botToken}`);
  });
});

describe('thread endpoints — error handling', () => {
  it('throws a descriptive error on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404, statusText: 'Not Found' }));
    await expect(getThread({ ...BASE, groupNo: GROUP, shortId: SHORT })).rejects.toThrow(/404/);
  });

  it('url-encodes group and short ids', async () => {
    fetchMock.mockResolvedValueOnce(mockEmptyResponse(200));
    await joinThread({ ...BASE, groupNo: 'g/1', shortId: 's 2' });
    expect(call().url).toBe(`${BASE.apiUrl}/v1/bot/groups/g%2F1/threads/s%202/join`);
  });
});

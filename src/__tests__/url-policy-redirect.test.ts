/**
 * S2 fetchWithRedirectGuard regression tests.
 *
 * Verifies that HTTP redirects to private addresses are blocked, NOT followed.
 *
 * DNS isolation: all hostnames in this file are fictitious. We mock
 * node:dns/promises.lookup to return a public IP for any "*.public.*"
 * hostname so the tests don't depend on the runner's resolver behavior
 * (local machine returns NXDOMAIN, CI gets ENOTFOUND — different error
 * shapes leak through assertPublicUrl and break unrelated assertions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    // Mock: any hostname containing 'public' resolves to a public IP
    // (TEST-NET-3, 203.0.113.0/24 — reserved for docs but treated as public
    // by isPrivateOrLocalAddress). Anything else throws like a real DNS
    // failure to surface as a clear test bug rather than a silent pass.
    if (hostname.includes('public')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

import { fetchWithRedirectGuard } from '../url-policy.js';

describe('fetchWithRedirectGuard (S2)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('follows redirects to other public hosts', async () => {
    // Hop 1: 302 to public host
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.public.example.com/final' },
      }),
    );
    // Hop 2: 200
    fetchSpy.mockResolvedValueOnce(
      new Response('done', { status: 200 }),
    );

    const resp = await fetchWithRedirectGuard('https://start.public.example.com/');
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Verify redirect: 'manual' was passed
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ redirect: 'manual' });
  });

  it('REJECTS redirect to private host (S2 fix)', async () => {
    // Hop 1: 302 to internal host
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );

    await expect(
      fetchWithRedirectGuard('https://attacker.public.example.com/redirect-trap'),
    ).rejects.toThrow(/private\/local/);

    // Only the first fetch should have happened — the redirect destination
    // must be rejected BEFORE fetching it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('REJECTS redirect to file:// scheme', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      }),
    );

    await expect(
      fetchWithRedirectGuard('https://attacker.public.example.com/'),
    ).rejects.toThrow(/non-http/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('REJECTS redirect to private IPv6 hex form (S5 + S2 combo)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://[::ffff:7f00:1]/' },
      }),
    );

    await expect(
      fetchWithRedirectGuard('https://attacker.public.example.com/'),
    ).rejects.toThrow(/private\/local/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects redirect loop after MAX_REDIRECTS', async () => {
    // Always return 302 to a different public host — creates an infinite-ish loop
    let counter = 0;
    fetchSpy.mockImplementation(() => {
      counter++;
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://hop-${counter}.public.example.com/` },
        }),
      );
    });

    await expect(
      fetchWithRedirectGuard('https://start.public.example.com/'),
    ).rejects.toThrow(/more than 10 redirects/);
    // 11 hops attempted (10 redirects + 1 over the limit)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(11);
  });

  it('returns 3xx without Location as a normal response (no infinite loop)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('no location header', { status: 302 }),
    );

    const resp = await fetchWithRedirectGuard('https://example.public.com/');
    expect(resp.status).toBe(302);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('fetchWithRedirectGuard perHopInit callback (S1 follow-up)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('callback receives currentUrl + previousUrl on each hop', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://hop1.public.example.com/' },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://hop2.public.example.com/' },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('done', { status: 200 }));

    const calls: Array<{ currentUrl: string; previousUrl: string | null }> = [];
    await fetchWithRedirectGuard('https://start.public.example.com/', (currentUrl, previousUrl) => {
      calls.push({ currentUrl, previousUrl });
      return {};
    });

    expect(calls).toEqual([
      { currentUrl: 'https://start.public.example.com/', previousUrl: null },
      { currentUrl: 'https://hop1.public.example.com/', previousUrl: 'https://start.public.example.com/' },
      { currentUrl: 'https://hop2.public.example.com/', previousUrl: 'https://hop1.public.example.com/' },
    ]);
  });

  it('callback can return different headers per hop', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.public.example.com/' },
      }),
    );
    fetchSpy.mockResolvedValueOnce(new Response('done', { status: 200 }));

    await fetchWithRedirectGuard('https://api.public.example.com/x', (currentUrl) => {
      const u = new URL(currentUrl);
      return u.host === 'api.public.example.com'
        ? { headers: { Authorization: 'Bearer secret' } }
        : {};
    });

    const hop1Init = fetchSpy.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    const hop2Init = fetchSpy.mock.calls[1][1] as RequestInit & { headers?: Record<string, string> };
    expect(hop1Init.headers).toMatchObject({ Authorization: 'Bearer secret' });
    expect(hop2Init.headers ?? {}).not.toHaveProperty('Authorization');
  });

  it('static init still works (backward compat)', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await fetchWithRedirectGuard('https://example.public.com/', {
      method: 'POST',
      headers: { 'x-test': 'yes' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'x-test': 'yes' },
      redirect: 'manual',
    });
  });
});

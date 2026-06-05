/**
 * tryResolveFile S1 SSRF + token scoping tests.
 *
 * Verifies:
 *   - SSRF defense: rejects private/loopback addresses without fetching
 *   - Token scoping: Authorization header sent ONLY when URL host matches apiUrl
 *   - Redirect guard: redirects to private hosts are blocked (via fetchWithRedirectGuard)
 *
 * DNS isolation: same rationale as url-policy-redirect.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    // Map all fictitious test hosts to a public IP so assertPublicUrl passes.
    // Anything else throws to surface as a clear test bug.
    const publicHosts = ['api.example.com', 'cdn.public-host.com', 'attacker.public.example.com'];
    if (publicHosts.includes(hostname) || hostname.includes('public')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

import { tryResolveFile } from '../inbound.js';

const API_URL = 'https://api.example.com';
const BOT_TOKEN = 'bf_secret_xyz';

describe('tryResolveFile S1: SSRF defense', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.each([
    'http://127.0.0.1/leak.json',
    'http://169.254.169.254/latest/meta-data/iam.json',
    'http://10.0.0.1/internal.json',
    'http://192.168.1.1/admin.json',
    'http://[::1]/loopback.json',
    'http://[::ffff:7f00:1]/hex-v4-mapped.json',  // S5 hex form
  ])('rejects fetch to private/local %s', async (url) => {
    const result = await tryResolveFile({
      url,
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'x.json',
    });
    expect(result).toHaveProperty('description');
    expect((result as { description: string }).description).toMatch(/拒绝下载|private|local/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects file:// scheme', async () => {
    const result = await tryResolveFile({
      url: 'file:///etc/passwd',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'passwd.txt',
    });
    expect(result).toHaveProperty('description');
    expect((result as { description: string }).description).toMatch(/拒绝下载|non-http/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('tryResolveFile S1: token scoping', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('hello world', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }) as Response,
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends Authorization header when URL host matches apiUrl host', async () => {
    await tryResolveFile({
      url: 'https://api.example.com/file/xyz/note.md',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'note.md',
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers).toMatchObject({ Authorization: `Bearer ${BOT_TOKEN}` });
  });

  it('does NOT send Authorization header for cross-host URL (CDN, etc.)', async () => {
    await tryResolveFile({
      url: 'https://cdn.public-host.com/file/xyz/note.md',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'note.md',
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('authorization');
  });

  it('does NOT send Authorization on apiUrl with different port (treated as different host)', async () => {
    await tryResolveFile({
      url: 'https://api.example.com:8080/file/x.md',
      botToken: BOT_TOKEN,
      apiUrl: 'https://api.example.com',
      filename: 'x.md',
    });

    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
    expect(headers).not.toHaveProperty('Authorization');
  });
});

describe('tryResolveFile: non-text extensions return description (no fetch)', () => {
  it.each([
    'photo.jpg',
    'video.mp4',
    'archive.zip',
    'random.bin',
  ])('returns description without fetching for %s', async (filename) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await tryResolveFile({
      url: `https://api.example.com/file/${filename}`,
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename,
    });
    expect(result).toHaveProperty('description');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('tryResolveFile S1 follow-up: per-hop credential scoping', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('DROPS Authorization header on cross-host redirect (the re-review bug)', async () => {
    // Same-host initial URL — hop 1 includes Authorization.
    // 302 Location: cross-host — hop 2 MUST NOT include Authorization,
    // even though the initial init said to.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.public.example.com/leak' },
      }) as Response,
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('attacker would have logged the token here', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }) as Response,
    );

    await tryResolveFile({
      url: 'https://api.example.com/file/leak.md',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'leak.md',
    });

    // First hop: same host as apiUrl, header present.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, hop1Init] = fetchSpy.mock.calls[0];
    const hop1Headers = (hop1Init as RequestInit & { headers: Record<string, string> }).headers;
    expect(hop1Headers).toMatchObject({ Authorization: `Bearer ${BOT_TOKEN}` });

    // Second hop: cross host, header must be absent.
    const [hop2Url, hop2Init] = fetchSpy.mock.calls[1];
    expect(String(hop2Url)).toContain('attacker.public.example.com');
    const hop2Headers = (hop2Init as RequestInit & { headers: Record<string, string> }).headers;
    expect(hop2Headers).not.toHaveProperty('Authorization');
    expect(hop2Headers).not.toHaveProperty('authorization');
  });

  it('keeps Authorization across same-host redirects', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://api.example.com/file/redirected.md' },
      }) as Response,
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('content', { status: 200, headers: { 'content-type': 'text/plain' } }) as Response,
    );

    await tryResolveFile({
      url: 'https://api.example.com/file/original.md',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'original.md',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchSpy.mock.calls) {
      const headers = (init as RequestInit & { headers: Record<string, string> }).headers;
      expect(headers).toMatchObject({ Authorization: `Bearer ${BOT_TOKEN}` });
    }
  });

  it('cross-host → same-host redirect ADDS Authorization on hop 2 (per-hop logic)', async () => {
    // Edge case: starts cross-host (no auth), 302s to api host.
    // Per-hop callback adds auth on hop 2 — correct: hop 2 is our own API host.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://api.example.com/file/x.md' },
      }) as Response,
    );
    fetchSpy.mockResolvedValueOnce(
      new Response('content', { status: 200, headers: { 'content-type': 'text/plain' } }) as Response,
    );

    await tryResolveFile({
      url: 'https://cdn.public-host.com/file/x.md',
      botToken: BOT_TOKEN,
      apiUrl: API_URL,
      filename: 'x.md',
    });

    const hop1Headers = (fetchSpy.mock.calls[0][1] as RequestInit & { headers: Record<string, string> }).headers;
    expect(hop1Headers).not.toHaveProperty('Authorization');

    const hop2Headers = (fetchSpy.mock.calls[1][1] as RequestInit & { headers: Record<string, string> }).headers;
    expect(hop2Headers).toMatchObject({ Authorization: `Bearer ${BOT_TOKEN}` });
  });
});

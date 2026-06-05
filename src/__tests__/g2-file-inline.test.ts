/**
 * G2 (file inlining) + G4 (history backfill) integration tests.
 *
 * DNS isolation: `tryResolveFile` calls `assertPublicUrl(url)` which performs
 * a DNS lookup for non-IP-literal hosts. These tests use fictitious
 * `api.example.com` hostnames; without a DNS mock the lookup hits the real
 * resolver (NXDOMAIN locally, ENOTFOUND in GitHub Actions) and bypasses the
 * mocked fetch — producing a "拒绝下载" description that fails the test.
 * Same fix pattern as inbound-ssrf.test.ts / url-policy-redirect.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname.includes('example.com')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

describe('G2: file inlining via tryResolveFile', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('inlines small text file content', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    const fileContent = 'def hello():\n    print("world")\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(fileContent));
        controller.close();
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response);

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/hello.py',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'hello.py',
    });

    expect(result).toHaveProperty('inlined');
    if ('inlined' in result) {
      expect(result.inlined).toBe(fileContent);
    }
  });

  it('rejects non-text extensions with size description', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/photo.jpg',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'photo.jpg',
      knownSize: 5_000,
    });

    expect(result).toHaveProperty('description');
    if ('description' in result) {
      expect(result.description).toContain('photo.jpg');
      expect(result.description).toContain('4.9KB');
    }
  });

  it('rejects files exceeding hard cap by knownSize', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/big.md',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'big.md',
      knownSize: 10 * 1024 * 1024, // 10 MB > 5MB cap
    });

    expect(result).toHaveProperty('description');
    if ('description' in result) {
      expect(result.description).toContain('超过下载上限');
    }
  });

  it('returns description on HTTP error', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      body: null,
    } as unknown as Response);

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/missing.md',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'missing.md',
    });

    expect(result).toHaveProperty('description');
    if ('description' in result) {
      expect(result.description).toContain('HTTP 404');
    }
  });

  it('returns description on network error', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/foo.md',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'foo.md',
    });

    expect(result).toHaveProperty('description');
    if ('description' in result) {
      expect(result.description).toContain('网络错误');
    }
  });

  it('extracts extension from URL when filename has none', async () => {
    const { tryResolveFile } = await import('../inbound.js');

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('# Title\n'));
          c.close();
        },
      }),
    } as unknown as Response);

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/something.md',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'something', // no extension
    });

    // URL extension .md is recognized
    expect(result).toHaveProperty('inlined');
  });

  it('streams file to temp path when exceeding inline cap', async () => {
    const { tryResolveFile, INLINE_FILE_MAX_BYTES } = await import('../inbound.js');

    // 25KB > 20KB inline cap
    const largeContent = 'A'.repeat(INLINE_FILE_MAX_BYTES + 5_000);
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(largeContent.slice(0, 10_000)),
      encoder.encode(largeContent.slice(10_000, 22_000)),
      encoder.encode(largeContent.slice(22_000)),
    ];
    let idx = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (idx < chunks.length) {
          controller.enqueue(chunks[idx++]);
        } else {
          controller.close();
        }
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response);

    const result = await tryResolveFile({
      url: 'https://api.example.com/file/big.txt',
      botToken: 'tok',
      apiUrl: 'https://api.example.com',
      filename: 'big.txt',
    });

    expect(result).toHaveProperty('tempPath');
    if ('tempPath' in result) {
      expect(result.tempPath).toContain('big.txt');
      expect(result.tempPath).toContain('/tmp/cc-channel-octo/inbound-files');
    }
  });
});

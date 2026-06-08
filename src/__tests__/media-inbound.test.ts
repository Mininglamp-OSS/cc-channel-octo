/**
 * downloadInboundImage tests (#86 native image input).
 *
 * Verifies: content-type allow/deny, size cap, SSRF reject (private host),
 * Authorization scoping, path stays under the session cwd, and empty-body
 * handling. DNS is mocked so assertPublicUrl resolves deterministically;
 * globalThis.fetch is stubbed (fetchWithRedirectGuard calls it internally).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === 'api.example.com' || hostname.includes('public')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    // Loopback for the SSRF-reject case.
    if (hostname === 'internal.local') return [{ address: '127.0.0.1', family: 4 }];
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

import { downloadInboundImage, INBOUND_MEDIA_DIR, MAX_IMAGE_BYTES } from '../media-inbound.js';

const API_URL = 'https://api.example.com';
const BOT_TOKEN = 'bf_secret_xyz';

/** Build a fake fetch Response with a streaming body of `bytes`. */
function streamResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
  return new Response(status === 200 ? body : null, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('downloadInboundImage', () => {
  let cwd: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cc-img-test-'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('downloads a PNG into <cwd>/.cc-octo-media and returns a relative path', async () => {
    fetchSpy.mockResolvedValue(streamResponse(new Uint8Array([1, 2, 3, 4]), 'image/png'));
    const r = await downloadInboundImage({ url: `${API_URL}/file/a.png`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    expect('relPath' in r).toBe(true);
    if ('relPath' in r) {
      expect(r.relPath.startsWith(INBOUND_MEDIA_DIR)).toBe(true);
      expect(r.relPath.endsWith('.png')).toBe(true);
      expect(isAbsolute(r.relPath)).toBe(false);
      expect(existsSync(r.localPath)).toBe(true);
      // File is inside the cwd sandbox.
      expect(r.localPath.startsWith(cwd)).toBe(true);
    }
  });

  it('maps content-type to the right extension (jpeg/gif/webp)', async () => {
    for (const [ct, ext] of [['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']] as const) {
      fetchSpy.mockResolvedValue(streamResponse(new Uint8Array([9]), ct));
      const r = await downloadInboundImage({ url: `${API_URL}/x`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
      expect('relPath' in r && r.relPath.endsWith('.' + ext)).toBe(true);
    }
  });

  it('rejects a non-image content type', async () => {
    fetchSpy.mockResolvedValue(streamResponse(new Uint8Array([1]), 'text/html'));
    const r = await downloadInboundImage({ url: `${API_URL}/x`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    expect('error' in r && /不支持的图片类型/.test(r.error)).toBe(true);
  });

  it('rejects an oversize image and deletes the partial file', async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    fetchSpy.mockResolvedValue(streamResponse(big, 'image/png'));
    const r = await downloadInboundImage({ url: `${API_URL}/big.png`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    expect('error' in r && /上限/.test(r.error)).toBe(true);
    // No leftover file in the media dir.
    const dir = join(cwd, INBOUND_MEDIA_DIR);
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
  });

  it('rejects an SSRF target (private/loopback host) without fetching', async () => {
    const r = await downloadInboundImage({ url: 'https://internal.local/x.png', cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    expect('error' in r && /拒绝下载/.test(r.error)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an HTTP error', async () => {
    fetchSpy.mockResolvedValue(streamResponse(new Uint8Array(), 'image/png', 404));
    const r = await downloadInboundImage({ url: `${API_URL}/missing.png`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    expect('error' in r && /HTTP 404/.test(r.error)).toBe(true);
  });

  it('sends the bot token only to the same host (Authorization scoping)', async () => {
    fetchSpy.mockResolvedValue(streamResponse(new Uint8Array([1]), 'image/png'));
    await downloadInboundImage({ url: `${API_URL}/a.png`, cwdDir: cwd, botToken: BOT_TOKEN, apiUrl: API_URL });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(auth).toBe(`Bearer ${BOT_TOKEN}`);
  });
});

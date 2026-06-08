/**
 * Inbound image download for native multimodal (issue #86).
 *
 * Octo delivers images as URLs. To let the agent actually SEE an image (not just
 * a URL string), we download it INTO the session's cwd sandbox so the model can
 * open it with the Read tool (the Claude Agent SDK's Read supports image files).
 * Writing under the session cwd means:
 *  - the agent can reach it with a relative path,
 *  - it's isolated per session (same partition as history/memory), and
 *  - the existing 7-day cwd janitor reclaims it — no separate cleanup needed.
 *
 * Reuses the same SSRF/redirect/size hardening as the file-download path.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertPublicUrl, fetchWithRedirectGuard } from './url-policy.js';
import { isSameHost } from './inbound.js';

/** Subdir (under the session cwd) where downloaded inbound images land. */
export const INBOUND_MEDIA_DIR = '.cc-octo-media';

/** Per-image hard cap. Claude's vision API rejects very large images; 5 MB
 *  matches the inbound file cap and is comfortably above any real chat image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Max images materialized from a single message (e.g. a RichText with many). */
export const MAX_IMAGES_PER_MESSAGE = 6;

const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Content-Type → file extension for the image formats Claude can natively read.
 * A response whose type isn't here is rejected (we don't feed unknown blobs to
 * the model as "images").
 */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export type ImageDownloadResult =
  | { localPath: string; relPath: string }
  | { error: string };

/**
 * Download one image URL into `<cwdDir>/.cc-octo-media/`. Returns the absolute
 * path and the path relative to the cwd (what we show the agent). On any
 * problem (SSRF reject, non-image type, oversize, HTTP error) returns
 * `{ error }` so the caller can fall back to the URL marker.
 */
export async function downloadInboundImage(params: {
  url: string;
  cwdDir: string;
  botToken: string;
  apiUrl: string;
}): Promise<ImageDownloadResult> {
  const { url, cwdDir, botToken, apiUrl } = params;

  // SSRF defense — reject private/loopback/link-local (and re-checked per hop
  // inside fetchWithRedirectGuard).
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { error: `拒绝下载: ${String(err)}` };
  }

  const signal = AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS);
  let resp: Awaited<ReturnType<typeof fetchWithRedirectGuard>>;
  try {
    // Scope Authorization PER HOP: only send the bot token while the current
    // hop is same-host as apiUrl (a redirect to another host drops it).
    resp = await fetchWithRedirectGuard(url, (currentUrl) => {
      const headers: Record<string, string> = {};
      if (isSameHost(currentUrl, apiUrl)) headers.Authorization = `Bearer ${botToken}`;
      return { headers, signal };
    });
  } catch (err) {
    return { error: `下载失败: ${String(err)}` };
  }

  if (!resp.ok) return { error: `下载失败 HTTP ${resp.status}` };

  // Only accept image content types Claude can read.
  const rawType = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = ALLOWED_IMAGE_TYPES[rawType];
  if (!ext) return { error: `不支持的图片类型: ${rawType || '未知'}` };

  const body = resp.body;
  if (!body) return { error: '响应无内容' };

  const dir = join(cwdDir, INBOUND_MEDIA_DIR);
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, `${randomUUID()}.${ext}`);

  // Stream to disk with a hard size cap (abort + delete on overflow).
  const reader = (body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }).getReader();
  const ws = createWriteStream(localPath);

  /** Tear down the write stream and remove the (possibly partial) file. */
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      // destroy() then wait for 'close' so the fd is released before unlink,
      // avoiding a race where unlink runs before the file is fully created.
      ws.once('close', () => resolve());
      ws.destroy();
    });
    await unlink(localPath).catch(() => {});
  };

  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        try { reader.cancel(); } catch { /* ignore */ }
        await cleanup();
        return { error: `图片超过大小上限 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` };
      }
      if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', r));
    }
    ws.end();
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    });
  } catch (err) {
    await cleanup();
    return { error: `下载失败: ${String(err)}` };
  }

  if (total === 0) {
    await cleanup();
    return { error: '图片为空' };
  }

  return { localPath, relPath: relative(cwdDir, localPath) };
}

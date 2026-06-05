/**
 * Inbound message resolver — converts BotMessage payload into LLM-friendly text.
 *
 * Each MessageType is rendered as either:
 *   - plain text (for Text)
 *   - text + media URL marker (for Image/GIF/Voice/Video/File)
 *   - structured placeholder (for Location/Card)
 *   - recursively expanded (for MultipleForward)
 *   - text + image URLs (for RichText)
 *
 * For text-extension files (.py/.ts/.md/.json etc.) the contents are inlined
 * up to a small byte budget (G2) so the agent can actually answer questions
 * about the file rather than just see its URL.
 */

import { createWriteStream, statSync } from 'node:fs';
import { mkdir, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessagePayload, ForwardMessage, ForwardUser } from './octo/types.js';
import { MessageType, RICH_TEXT_BLOCK_IMAGE, RICH_TEXT_BLOCK_TEXT, RICH_TEXT_IMAGE_PLACEHOLDER } from './octo/types.js';

// ─── Configuration ─────────────────────────────────────────────────────────

/** Extensions we will try to inline (text-like content). */
export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml',
  'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'go', 'java', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'toml', 'ini', 'conf', 'cfg', 'env',
  'sql', 'graphql', 'gql', 'proto',
]);

/** Maximum bytes to inline a text file in the LLM prompt (G2). */
export const INLINE_FILE_MAX_BYTES = 20 * 1024;

/** Maximum bytes to download for any text file (inline or temp). */
const MAX_FILE_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/** HTTP timeout for file download. */
const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Temp directory for non-inlinable downloads. */
const TEMP_DIR = join('/tmp', 'cc-channel-octo', 'inbound-files');

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Result of resolving a single inbound BotMessage payload.
 *
 * `text` is the LLM-facing rendering — always present, never empty for
 * supported types. `mediaUrl` exposes any single primary attachment URL,
 * `mediaUrls` exposes all attachments for RichText (which can carry several).
 */
export interface ResolvedContent {
  /** LLM-facing text (description + URL markers as appropriate). */
  text: string;
  /** Primary media URL (first one for RichText). */
  mediaUrl?: string;
  /** All embedded media URLs (RichText only — text/image types use mediaUrl). */
  mediaUrls?: string[];
  /** When true the agent received the file's literal contents inline. */
  inlinedFile?: boolean;
  /** Local temp path when a non-inlined file was downloaded for the agent. */
  localFilePath?: string;
}

// ─── URL helpers ───────────────────────────────────────────────────────────

/** Resolve a relative storage path against the bot API base. */
export function buildMediaUrl(relUrl?: string, apiUrl?: string): string | undefined {
  if (!relUrl) return undefined;
  if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) return relUrl;
  let storagePath = relUrl;
  if (storagePath.startsWith('file/preview/')) {
    storagePath = storagePath.substring('file/preview/'.length);
  } else if (storagePath.startsWith('file/')) {
    storagePath = storagePath.substring('file/'.length);
  }
  const baseUrl = apiUrl?.replace(/\/+$/, '') ?? '';
  return `${baseUrl}/file/${storagePath}`;
}

/** Guess MIME type from filename extension.
 *  Kept for future use (download path may need to override server content-type for G22). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function guessMime(pathOrName?: string, fallback = 'application/octet-stream'): string {
  if (!pathOrName) return fallback;
  const ext = pathOrName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    pdf: 'application/pdf', zip: 'application/zip',
    txt: 'text/plain', json: 'application/json', csv: 'text/csv', md: 'text/markdown',
  };
  return map[ext] ?? fallback;
}

// ─── RichText (type=14) expansion ─────────────────────────────────────────

function normalizeRichTextBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
  }
  if (typeof content === 'string' && content) {
    return [{ type: RICH_TEXT_BLOCK_TEXT, text: content }];
  }
  return [];
}

function buildRichTextPlain(blocks: Array<Record<string, unknown>>): string {
  let out = '';
  for (const blk of blocks) {
    if (blk.type === RICH_TEXT_BLOCK_IMAGE) {
      out += RICH_TEXT_IMAGE_PLACEHOLDER;
    } else if (blk.type === RICH_TEXT_BLOCK_TEXT) {
      // Guard against non-string text (would render as "[object Object]")
      out += typeof blk.text === 'string' ? blk.text : '';
    } else if (typeof blk.text === 'string' && blk.text) {
      out += blk.text;
    }
  }
  return out;
}

/**
 * Expand a RichText (type=14) payload into `{ text, mediaUrls[] }`.
 *
 * Mirrors upstream's MultipleForward expansion pattern:
 *   - text: prefer top-level `plain` (server-authoritative); else assemble
 *     from content blocks (text → text, image → `[图片]` placeholder)
 *   - mediaUrls: collect all image-block `url` (sanitized for string type)
 */
export function resolveRichTextContent(
  payload: { content?: unknown; plain?: unknown },
  apiUrl?: string,
): { text: string; mediaUrls: string[] } {
  const blocks = normalizeRichTextBlocks(payload?.content);
  const mediaUrls: string[] = [];
  for (const blk of blocks) {
    // Defensive: only collect string URLs so a malformed `{url: {}}` cannot
    // crash buildMediaUrl downstream.
    if (blk.type === RICH_TEXT_BLOCK_IMAGE && typeof blk.url === 'string' && blk.url) {
      const full = buildMediaUrl(blk.url, apiUrl);
      if (full) mediaUrls.push(full);
    }
  }
  const topPlain = typeof payload?.plain === 'string' ? payload.plain : '';
  const text = topPlain.trim() !== '' ? topPlain : buildRichTextPlain(blocks);
  return { text, mediaUrls };
}

// ─── Inner message rendering (MultipleForward children) ──────────────────

function resolveInnerMessageText(payload: ForwardMessage['payload'], apiUrl?: string): string {
  if (!payload) return '';
  const fullUrl = buildMediaUrl(payload.url, apiUrl);
  switch (payload.type) {
    case MessageType.Text:
      return payload.content ?? '';
    case MessageType.Image:
      return fullUrl ? `[图片]\n${fullUrl}` : '[图片]';
    case MessageType.GIF:
      return fullUrl ? `[GIF]\n${fullUrl}` : '[GIF]';
    case MessageType.Voice:
      return fullUrl ? `[语音]\n${fullUrl}` : '[语音]';
    case MessageType.Video:
      return fullUrl ? `[视频]\n${fullUrl}` : '[视频]';
    case MessageType.Location:
      return '[位置信息]';
    case MessageType.Card:
      return '[名片]';
    case MessageType.File: {
      const label = payload.name ? `[文件: ${payload.name}]` : '[文件]';
      return fullUrl ? `${label}\n${fullUrl}` : label;
    }
    case MessageType.MultipleForward:
      return '[合并转发]';
    case MessageType.RichText: {
      const rt = resolveRichTextContent(payload as { content?: unknown; plain?: unknown }, apiUrl);
      return rt.text || '[图文消息]';
    }
    default:
      return payload.content ?? '[消息]';
  }
}

/** Expand a MultipleForward payload into a readable transcript. */
export function resolveMultipleForwardText(
  payload: { users?: ForwardUser[]; msgs?: ForwardMessage[] },
  apiUrl?: string,
): string {
  const users: ForwardUser[] = payload?.users ?? [];
  const msgs: ForwardMessage[] = payload?.msgs ?? [];
  const userMap = new Map<string, string>();
  for (const u of users) {
    if (u.uid && u.name) userMap.set(u.uid, u.name);
  }
  const lines: string[] = ['[合并转发: 聊天记录]'];
  for (const m of msgs) {
    const senderName = userMap.get(m.from_uid) ?? m.from_uid;
    if (m.payload?.type === MessageType.MultipleForward) {
      const nested = resolveMultipleForwardText(m.payload, apiUrl);
      lines.push(`${senderName}: [合并转发]`);
      lines.push(nested);
    } else {
      lines.push(`${senderName}: ${resolveInnerMessageText(m.payload, apiUrl)}`);
    }
  }
  return lines.join('\n');
}

// ─── Core resolver ─────────────────────────────────────────────────────────

/**
 * Render an inbound payload to LLM-friendly text + optional media metadata.
 *
 * This is the synchronous part — file inlining (which requires HTTP) is a
 * separate async step done by `tryInlineFile()`.
 */
export function resolveContent(payload: MessagePayload | undefined, apiUrl?: string): ResolvedContent {
  if (!payload) return { text: '' };

  switch (payload.type) {
    case MessageType.Text:
      return { text: payload.content ?? '' };

    case MessageType.Image: {
      const imgUrl = buildMediaUrl(payload.url, apiUrl);
      return {
        text: imgUrl ? `[图片]\n${imgUrl}` : '[图片]',
        mediaUrl: imgUrl,
      };
    }

    case MessageType.GIF: {
      const url = buildMediaUrl(payload.url, apiUrl);
      return {
        text: url ? `[GIF]\n${url}` : '[GIF]',
        mediaUrl: url,
      };
    }

    case MessageType.Voice: {
      const url = buildMediaUrl(payload.url, apiUrl);
      return {
        // G22: language model receives the URL as a marker; transcription is
        // out of scope for v0.2 and tracked separately.
        text: url ? `[语音消息]\n${url}` : '[语音消息]',
        mediaUrl: url,
      };
    }

    case MessageType.Video: {
      const url = buildMediaUrl(payload.url, apiUrl);
      return {
        text: url ? `[视频]\n${url}` : '[视频]',
        mediaUrl: url,
      };
    }

    case MessageType.File: {
      const url = buildMediaUrl(payload.url, apiUrl);
      const fileName = typeof payload.name === 'string' ? payload.name : '未知文件';
      return {
        text: url ? `[文件: ${fileName}]\n${url}` : `[文件: ${fileName}]`,
        mediaUrl: url,
      };
    }

    case MessageType.Location: {
      const lat = (payload.latitude ?? payload.lat) as number | undefined;
      const lng = (payload.longitude ?? payload.lng ?? payload.lon) as number | undefined;
      return {
        text: lat != null && lng != null ? `[位置信息: ${lat},${lng}]` : '[位置信息]',
      };
    }

    case MessageType.Card: {
      const cardName = typeof payload.name === 'string' ? payload.name : '未知';
      const cardUid = typeof payload.uid === 'string' ? payload.uid : '';
      return {
        text: cardUid ? `[名片: ${cardName} (${cardUid})]` : `[名片: ${cardName}]`,
      };
    }

    case MessageType.MultipleForward: {
      return {
        text: resolveMultipleForwardText(
          payload as unknown as { users?: ForwardUser[]; msgs?: ForwardMessage[] },
          apiUrl,
        ),
      };
    }

    case MessageType.RichText: {
      const rt = resolveRichTextContent(payload as unknown as { content?: unknown; plain?: unknown }, apiUrl);
      return {
        text: rt.text,
        ...(rt.mediaUrls.length > 0 ? { mediaUrl: rt.mediaUrls[0], mediaUrls: rt.mediaUrls } : {}),
      };
    }

    default:
      return { text: payload.content ?? payload.url ?? '[消息]' };
  }
}

/** Placeholder text used when reconstructing a historical (API-backfilled) message. */
export function resolveHistoricalMessagePlaceholder(type?: number, name?: string): string {
  switch (type) {
    case MessageType.Image: return '[图片]';
    case MessageType.GIF: return '[GIF]';
    case MessageType.Voice: return '[语音消息]';
    case MessageType.Video: return '[视频]';
    case MessageType.File: return `[文件: ${name ?? '未知文件'}]`;
    case MessageType.Location: return '[位置信息]';
    case MessageType.Card: return '[名片]';
    case MessageType.MultipleForward: return '[合并转发]';
    case MessageType.RichText: return '[图文消息]';
    case MessageType.Text:
    default:
      return '';
  }
}

// ─── File inlining (G2) ────────────────────────────────────────────────────

/** Best-effort cleanup of temp files older than 1 hour. */
async function cleanupOldTempFiles(): Promise<void> {
  try {
    const entries = await readdir(TEMP_DIR);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of entries) {
      try {
        const filePath = join(TEMP_DIR, entry);
        const info = await stat(filePath);
        if (info.mtimeMs < cutoff) await unlink(filePath);
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

function extractExtension(url: string, fallbackName?: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop()?.toLowerCase() ?? '';
    if (ext && ext.length <= 8) return ext;
  } catch {
    /* fall through */
  }
  return fallbackName?.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Attempt to inline a text file's contents, or download it to a temp path.
 *
 * Returns:
 *   - `{ inlined: text }` when the file is text-extension and under the inline cap
 *   - `{ tempPath }`      when the file is text-extension but exceeds the cap
 *                         (downloaded to disk so the agent can read it)
 *   - `{ description }`   when the file isn't text or download failed
 */
export async function tryResolveFile(params: {
  url: string;
  botToken: string;
  filename: string;
  knownSize?: number;
}): Promise<
  | { inlined: string }
  | { tempPath: string }
  | { description: string }
> {
  const { url, botToken, filename, knownSize } = params;
  const ext = extractExtension(url, filename);
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    // Non-text — surface size info if known
    return {
      description: knownSize != null
        ? `[文件: ${filename} (${formatBytes(knownSize)})]`
        : `[文件: ${filename}]`,
    };
  }

  // Skip download if known to exceed hard cap
  if (knownSize != null && knownSize > MAX_FILE_DOWNLOAD_BYTES) {
    return { description: `[文件: ${filename} (${formatBytes(knownSize)}) - 超过下载上限 ${formatBytes(MAX_FILE_DOWNLOAD_BYTES)}]` };
  }

  // Download with streaming + size guard
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { description: `[文件: ${filename} - 下载失败 HTTP ${resp.status}]` };
    }
    const body = resp.body;
    if (!body) {
      return { description: `[文件: ${filename} - 响应无内容]` };
    }

    // Inline path: read up to INLINE_FILE_MAX_BYTES, fall through to temp on overflow
    const reader = (body as unknown as { getReader: () => ReadableStreamDefaultReader<Uint8Array> }).getReader();
    const inlineChunks: Uint8Array[] = [];
    let inlineBytes = 0;
    let exceededInline = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      inlineBytes += value.byteLength;
      if (inlineBytes > INLINE_FILE_MAX_BYTES) {
        exceededInline = true;
        // Continue draining for the temp path
        inlineChunks.push(value);
        if (inlineBytes > MAX_FILE_DOWNLOAD_BYTES) {
          try { reader.cancel(); } catch { /* ignore */ }
          return { description: `[文件: ${filename} (${formatBytes(inlineBytes)}) - 超过下载上限]` };
        }
        // Drain rest into chunks for temp write
        break;
      }
      inlineChunks.push(value);
    }

    if (!exceededInline) {
      // Inline the content
      const buf = Buffer.concat(inlineChunks.map((c) => Buffer.from(c)));
      return { inlined: buf.toString('utf-8') };
    }

    // Drain remaining body into the temp file
    await mkdir(TEMP_DIR, { recursive: true });
    cleanupOldTempFiles().catch(() => {});
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const tempPath = join(TEMP_DIR, `${randomUUID()}-${safeName}`);
    const ws = createWriteStream(tempPath);
    try {
      for (const chunk of inlineChunks) {
        if (!ws.write(chunk)) await new Promise<void>((r) => ws.once('drain', r));
      }
      let totalBytes = inlineBytes;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_FILE_DOWNLOAD_BYTES) {
          try { reader.cancel(); } catch { /* ignore */ }
          ws.destroy();
          await unlink(tempPath).catch(() => {});
          return { description: `[文件: ${filename} (${formatBytes(totalBytes)}) - 超过下载上限]` };
        }
        if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', r));
      }
      ws.end();
      await new Promise<void>((resolve, reject) => {
        ws.on('finish', () => resolve());
        ws.on('error', reject);
      });
      const sizeInfo = statSync(tempPath).size;
      return { tempPath, ...({ description: `[文件: ${filename} (${formatBytes(sizeInfo)}) - 已下载到 ${tempPath}]` } as { description?: string }) };
    } catch (err) {
      ws.destroy();
      await unlink(tempPath).catch(() => {});
      return { description: `[文件: ${filename} - 下载错误: ${String(err)}]` };
    }
  } catch (err) {
    return { description: `[文件: ${filename} - ${String(err).includes('TimeoutError') ? '下载超时' : '网络错误'}]` };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

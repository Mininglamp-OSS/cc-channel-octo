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
import { assertPublicUrl, fetchWithRedirectGuard } from './url-policy.js';

/**
 * S1 helper: same-host check for credential scoping.
 * Returns true only when both URLs parse successfully and have matching host
 * (case-insensitive). Falsy or malformed inputs return false (fail-closed).
 */
function isSameHost(url: string, apiUrl: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === new URL(apiUrl).host.toLowerCase();
  } catch {
    return false;
  }
}

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

// ─── RichText / MultipleForward input budgets (C1 / Stage 6) ─────────────────────
//
// These caps apply per-payload at parse time. They are independent of — and
// strictly tighter than — the system-prompt-wide 100 KiB cap in agent-bridge
// (D1, PR#39). Goal: stop a single malicious payload from spending the
// entire system-prompt budget or triggering OOM during parsing.

/** Maximum blocks parsed from a RichText payload. */
export const RICH_TEXT_MAX_BLOCKS = 50;
/** Maximum image URLs extracted from a RichText payload. */
export const RICH_TEXT_MAX_MEDIA_URLS = 20;
/** Maximum bytes of rendered text from a single RichText payload (matches Text gate). */
export const RICH_TEXT_MAX_OUTPUT_BYTES = 32 * 1024;

/** Maximum recursion depth for MultipleForward expansion. */
export const MULTIPLE_FORWARD_MAX_DEPTH = 3;
/** Maximum number of inner messages rendered per MultipleForward level. */
export const MULTIPLE_FORWARD_MAX_MESSAGES = 50;
/** Maximum bytes of rendered transcript from a single MultipleForward payload. */
export const MULTIPLE_FORWARD_MAX_OUTPUT_BYTES = 8 * 1024;

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

/**
 * Resolve a relative storage path against the bot API base.
 *
 * S1 + P1.2 (Stage 6): Hardened against absolute-URL smuggling and path
 * traversal:
 *   - Reject scheme-relative URLs (`//attacker.com/...`)
 *   - Reject path-traversal segments (`..`, `.`)
 *   - Reject backslash injection
 *   - For absolute http(s) URLs: only allow when host matches apiUrl host.
 *     This is the chokepoint that prevents an attacker-controlled
 *     payload.url from later being fetched with the bot's Authorization
 *     header (which would leak botToken to the attacker's server).
 */
export function buildMediaUrl(relUrl?: string, apiUrl?: string): string | undefined {
  if (!relUrl) return undefined;

  // Reject backslashes outright — they're not valid in URL paths and are a
  // known Windows-style traversal vector when normalized.
  if (relUrl.includes('\\')) return undefined;

  // Reject scheme-relative URLs (`//attacker.com/path`).
  if (relUrl.startsWith('//')) return undefined;

  // Absolute http(s) URL — only allow when host matches apiUrl host.
  if (relUrl.startsWith('http://') || relUrl.startsWith('https://')) {
    if (!apiUrl) return undefined;
    try {
      const target = new URL(relUrl);
      const base = new URL(apiUrl);
      if (target.host.toLowerCase() !== base.host.toLowerCase()) return undefined;
      if (target.protocol !== base.protocol) return undefined;
      return relUrl;
    } catch {
      return undefined;
    }
  }

  // Relative path — strip /file/ or /file/preview/ prefix then enforce no traversal.
  //
  // S4 follow-up (PR#38 round-3, Yujiawei + 李飞飞): the literal `..`/`.` check
  // was bypassable via percent-encoded dot-segments (`%2e%2e`, `%2E.`, `.%2e`,
  // etc.). WHATWG URL parser decodes `%2e` for dot-segment normalization, so
  // `<apiHost>/file/%2e%2e/internal/secret.env` normalizes to
  // `<apiHost>/internal/secret.env`, escaping the `/file/` sandbox. Combined
  // with the same-host Authorization scoping, this exfiltrates internal
  // authenticated paths using the bot's botToken.
  //
  // Fix: after assembling the candidate URL, parse via WHATWG `new URL()` and
  // assert the normalized pathname is still under `/file/`. This catches ALL
  // encoded-dot variants (lower/upper hex, mixed `%2e.`, raw `..`) in one
  // check, no matter how attacker spells them.
  let storagePath = relUrl;
  if (storagePath.startsWith('file/preview/')) {
    storagePath = storagePath.substring('file/preview/'.length);
  } else if (storagePath.startsWith('file/')) {
    storagePath = storagePath.substring('file/'.length);
  }
  // Cheap literal pre-check still useful as defense-in-depth.
  const segments = storagePath.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return undefined;
  }
  if (storagePath.startsWith('/')) return undefined;

  const baseUrl = apiUrl?.replace(/\/+$/, '') ?? '';
  const candidate = `${baseUrl}/file/${storagePath}`;

  // WHATWG-canonical sandbox check: after URL normalization, pathname must
  // still start with `/file/`. If `%2e%2e` (or any other encoded-dot variant)
  // would have escaped the prefix, normalize collapses it and we reject here.
  try {
    const normalized = new URL(candidate);
    if (!normalized.pathname.startsWith('/file/')) return undefined;
  } catch {
    return undefined;
  }

  return candidate;
}

// ─── RichText (type=14) expansion ─────────────────────────────────────────

function normalizeRichTextBlocks(content: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    // C1 / P1.4: cap blocks parsed per payload. A malicious sender could send
    // 10k blocks of empty text to spend parser CPU + downstream budget.
    return content
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .slice(0, RICH_TEXT_MAX_BLOCKS);
  }
  if (typeof content === 'string' && content) {
    return [{ type: RICH_TEXT_BLOCK_TEXT, text: content }];
  }
  return [];
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending a marker.
 * Shrinks by single chars so multi-byte (CJK / emoji) characters never get
 * split. Returns `{ text, truncated }` so callers can decide whether to
 * emit a notice.
 */
function truncateByBytes(input: string, maxBytes: number, marker: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(input, 'utf-8') <= maxBytes) {
    return { text: input, truncated: false };
  }
  // Generous upfront slice, then trim by bytes (covers ASCII fast path and
  // CJK without quadratic scan over an unbounded string).
  let truncated = input.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, 'utf-8') > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return { text: truncated + marker, truncated: true };
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
 *
 * C1 / P1.4 (Stage 6): output text is truncated to RICH_TEXT_MAX_OUTPUT_BYTES
 * (32 KiB — matches the Text payload gate in session-router) and mediaUrls is
 * capped at RICH_TEXT_MAX_MEDIA_URLS to prevent prompt-budget exhaustion.
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
      if (mediaUrls.length >= RICH_TEXT_MAX_MEDIA_URLS) break;
    }
  }
  const topPlain = typeof payload?.plain === 'string' ? payload.plain : '';
  const rawText = topPlain.trim() !== '' ? topPlain : buildRichTextPlain(blocks);
  const { text } = truncateByBytes(rawText, RICH_TEXT_MAX_OUTPUT_BYTES, '\n[RichText truncated]');
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

/**
 * Expand a MultipleForward payload into a readable transcript.
 *
 * C1 / P1.3 (Stage 6): bounded by three caps to prevent DoS via deeply nested
 * or massive forwarded payloads:
 *   - depth   ≤ MULTIPLE_FORWARD_MAX_DEPTH (default 3) — stack-safe
 *   - msgs    ≤ MULTIPLE_FORWARD_MAX_MESSAGES per level — CPU bound
 *   - output  ≤ MULTIPLE_FORWARD_MAX_OUTPUT_BYTES — prompt budget
 *
 * The internal _depth parameter is hop-counted (top-level = 0). Going beyond
 * the depth cap emits a single placeholder line instead of recursing.
 */
export function resolveMultipleForwardText(
  payload: { users?: ForwardUser[]; msgs?: ForwardMessage[] },
  apiUrl?: string,
  _depth = 0,
): string {
  if (_depth >= MULTIPLE_FORWARD_MAX_DEPTH) {
    return '[合并转发: 嵌套已截断]';
  }
  const users: ForwardUser[] = payload?.users ?? [];
  const rawMsgs: ForwardMessage[] = payload?.msgs ?? [];
  // Cap inner messages per level to prevent quadratic CPU on adversarial input.
  const msgs = rawMsgs.slice(0, MULTIPLE_FORWARD_MAX_MESSAGES);
  const truncatedCount = rawMsgs.length - msgs.length;
  const userMap = new Map<string, string>();
  for (const u of users) {
    if (u.uid && u.name) userMap.set(u.uid, u.name);
  }
  const lines: string[] = ['[合并转发: 聊天记录]'];
  for (const m of msgs) {
    const senderName = userMap.get(m.from_uid) ?? m.from_uid;
    if (m.payload?.type === MessageType.MultipleForward) {
      const nested = resolveMultipleForwardText(m.payload, apiUrl, _depth + 1);
      lines.push(`${senderName}: [合并转发]`);
      lines.push(nested);
    } else {
      lines.push(`${senderName}: ${resolveInnerMessageText(m.payload, apiUrl)}`);
    }
  }
  if (truncatedCount > 0) {
    lines.push(`[合并转发: 还有 ${truncatedCount} 条消息未展示]`);
  }
  const out = lines.join('\n');
  // Final output budget guard — even with msg/depth caps, a single inner
  // message text could be large. Truncate once at the top after assembly.
  const { text } = truncateByBytes(out, MULTIPLE_FORWARD_MAX_OUTPUT_BYTES, '\n[合并转发: 输出已截断]');
  return text;
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
  apiUrl: string;
  filename: string;
  knownSize?: number;
}): Promise<
  | { inlined: string }
  | { tempPath: string }
  | { description: string }
> {
  const { url, botToken, apiUrl, filename, knownSize } = params;
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

  // S1: SSRF defense — reject private/loopback/link-local addresses.
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { description: `[文件: ${filename} - 拒绝下载: ${String(err)}]` };
  }

  // S1 (re-review fix): scope Authorization PER HOP, not statically.
  // The previous implementation set the header once based on the initial URL
  // and then `fetchWithRedirectGuard` reused the same init across redirects —
  // meaning a same-host initial URL that 302'd to attacker.com would still
  // ship the Authorization header to the attacker. We now pass a perHopInit
  // callback so the header is recomputed per hop and dropped whenever the
  // current hop's host differs from apiUrl host.
  const signal = AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS);

  // Download with streaming + size guard. fetchWithRedirectGuard
  // re-validates SSRF on every redirect hop (S2) AND now re-decides the
  // Authorization header per hop (S1 follow-up).
  try {
    const resp = await fetchWithRedirectGuard(url, (currentUrl) => {
      const headers: Record<string, string> = {};
      if (isSameHost(currentUrl, apiUrl)) {
        headers.Authorization = `Bearer ${botToken}`;
      }
      return { headers, signal };
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

/**
 * Media upload pipeline — COS STS credentials + cos-nodejs-sdk-v5 upload + sendMediaMessage.
 *
 * Supports three media URL forms:
 *   - data:<mime>[;base64],<data>  — inline payload
 *   - file:///<absolute path>      — local file (streaming)
 *   - http(s)://...                — download to temp file then upload
 *
 * 500MB max file size. Temp files cleaned up in finally.
 * Image dimensions parsed from header bytes (PNG/JPEG/GIF/WebP).
 */

import path from "node:path";
import { mkdir, open, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import COS from "cos-nodejs-sdk-v5";

import {
  ChannelType,
  MessageType,
  RICH_TEXT_BLOCK_IMAGE,
  RICH_TEXT_BLOCK_TEXT,
  RICH_TEXT_IMAGE_PLACEHOLDER,
  type MentionEntity,
  type RichTextBlock,
  type SendMessageResult,
} from "./octo/types.js";
import {
  getUploadCredentials,
  sendMediaMessage,
  sendRichTextMessage,
} from "./octo/api.js";

const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const UPLOAD_TEMP_DIR = path.join("/tmp", "cc-octo-upload");

// ─── Content type inference ────────────────────────────────────────────────

/** Infer MIME type from filename extension. */
export function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".bmp": "image/bmp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
    ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".xml": "text/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Append charset=utf-8 to text/* content types when missing. */
export function ensureTextCharset(contentType: string): string {
  if (contentType.startsWith("text/") && !contentType.includes("charset")) {
    return contentType + "; charset=utf-8";
  }
  return contentType;
}

// ─── Image dimension parsing (PNG / JPEG / GIF / WebP) ─────────────────────

export function parseImageDimensions(
  buf: Buffer,
  mime: string,
): { width: number; height: number } | null {
  try {
    if (mime === "image/png" && buf.length > 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20.
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && buf.length > 2) {
      // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker.
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] !== 0xFF) break;
        const marker = buf[offset + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          return {
            width: buf.readUInt16BE(offset + 7),
            height: buf.readUInt16BE(offset + 5),
          };
        }
        const len = buf.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
    if (mime === "image/gif" && buf.length > 10) {
      // GIF: width at offset 6 (2 bytes LE), height at offset 8.
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buf.length > 30) {
      // WebP VP8: width at offset 26, height at offset 28 (2 bytes LE, mask 0x3FFF).
      if (buf.toString("ascii", 12, 16) === "VP8 " && buf.length > 29) {
        return {
          width: buf.readUInt16LE(26) & 0x3FFF,
          height: buf.readUInt16LE(28) & 0x3FFF,
        };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/** Read first 64KB of a file and parse image dimensions. */
export async function parseImageDimensionsFromFile(
  filePath: string,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  const HEADER_SIZE = 65536;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(filePath, "r");
    const buf = Buffer.alloc(HEADER_SIZE);
    const { bytesRead } = await fh.read(buf, 0, HEADER_SIZE, 0);
    return parseImageDimensions(buf.subarray(0, bytesRead), mime);
  } catch { /* ignore read/parse errors */ }
  finally { await fh?.close(); }
  return null;
}

// ─── Content-Disposition (for video/audio inline, file attachment) ─────────

const CD_UNSAFE_RE = /["\\\x00-\x1F\x7F;]/;

function rfc5987Encode(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function buildContentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const isAsciiSafe = /^[\x20-\x7E]+$/.test(filename) && !CD_UNSAFE_RE.test(filename);
  if (isAsciiSafe) return `${type}; filename="${filename}"`;
  const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
  return `${type}; filename="download${ext}"; filename*=UTF-8''${rfc5987Encode(filename)}`;
}

// ─── Filename sanitization (defense-in-depth for temp file paths) ──────────

function sanitizeFilename(name: string): string {
  // Strip path separators and reject traversal segments.
  const base = name.replace(/[/\\]/g, "_").trim();
  if (!base || base === "." || base === "..") return "file";
  if (base.split(/[/\\]/).some(seg => seg === ".." || seg === ".")) return "file";
  return base.slice(0, 255); // bounded length
}

// ─── COS upload ────────────────────────────────────────────────────────────

export async function uploadFileToCOS(params: {
  credentials: { tmpSecretId: string; tmpSecretKey: string; sessionToken: string };
  startTime: number;
  expiredTime: number;
  bucket: string;
  region: string;
  key: string;
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize?: number;
  contentType: string;
  cdnBaseUrl?: string;
  filename?: string;
}): Promise<{ url: string }> {
  const cos = new COS({
    SecretId: params.credentials.tmpSecretId,
    SecretKey: params.credentials.tmpSecretKey,
    SecurityToken: params.credentials.sessionToken,
    StartTime: params.startTime,
    ExpiredTime: params.expiredTime,
  } as never);

  let contentDisposition: string | undefined;
  if (params.filename) {
    const ct = params.contentType;
    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      contentDisposition = buildContentDisposition(params.filename, 'inline');
    } else if (!ct.startsWith('image/')) {
      contentDisposition = buildContentDisposition(params.filename, 'attachment');
    }
  }

  const putParams: Record<string, unknown> = {
    Bucket: params.bucket,
    Region: params.region,
    Key: params.key,
    Body: params.fileBody,
    ContentType: params.contentType,
    ...(contentDisposition && { ContentDisposition: contentDisposition }),
  };
  if (params.fileSize != null) {
    putParams.ContentLength = params.fileSize;
  }

  return new Promise((resolve, reject) => {
    cos.putObject(putParams as never, (err: unknown, data: { Location?: string }) => {
      if (err) {
        const errMsg = err instanceof Error
          ? err.message
          : (err && typeof err === 'object' && 'message' in err
              ? String((err as { message: unknown }).message)
              : JSON.stringify(err));
        reject(new Error(`COS upload failed: ${errMsg}`));
        return;
      }
      // Prefer CDN base URL over raw COS Location.
      let url: string;
      if (params.cdnBaseUrl) {
        const base = params.cdnBaseUrl.replace(/\/+$/, "");
        // Re-encode each path segment: COS keys may contain UTF-8 chars
        // (e.g. Chinese filenames). Without re-encoding, the IM client decodes
        // once and requests a key with raw UTF-8 chars → NoSuchKey/404.
        const reEncodedKey = params.key
          .split("/")
          .map(seg => encodeURIComponent(seg))
          .join("/");
        url = `${base}/${reEncodedKey}`;
      } else {
        url = data.Location ? `https://${data.Location}` : "";
      }
      if (!url) {
        reject(new Error("COS upload succeeded but returned no Location URL"));
        return;
      }
      resolve({ url });
    });
  });
}

// ─── Download HTTP(S) URL to temp file ─────────────────────────────────────

async function downloadToTempFile(
  url: string,
  filename: string,
  signal?: AbortSignal,
): Promise<{ tempPath: string; contentType: string | undefined }> {
  await mkdir(UPLOAD_TEMP_DIR, { recursive: true });
  const safeName = sanitizeFilename(filename);
  const tempPath = path.join(UPLOAD_TEMP_DIR, `${randomUUID()}-${safeName}`);

  // HEAD first to check size.
  const head = await fetch(url, { method: "HEAD", signal: signal ?? AbortSignal.timeout(30_000) });
  const contentLength = Number(head.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large (${contentLength} bytes, max ${MAX_UPLOAD_SIZE})`);
  }

  const resp = await fetch(url, { signal: signal ?? AbortSignal.timeout(300_000) });
  if (!resp.ok) throw new Error(`Failed to download media from ${url}: ${resp.status}`);
  const contentType = resp.headers.get("content-type") ?? undefined;

  const body = resp.body;
  if (!body) throw new Error(`No response body from ${url}`);
  const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const ws = createWriteStream(tempPath);
  try {
    await pipeline(nodeStream, ws);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
  return { tempPath, contentType };
}

// ─── Top-level orchestrator: uploadAndSendMedia ────────────────────────────

interface ResolvedFile {
  fileBody: Buffer | NodeJS.ReadableStream;
  fileSize: number;
  contentType: string;
  filename: string;
  tempPath?: string; // present when we created a temp file (cleanup in finally)
  localFilePath?: string; // present when we have a local path for dimension parsing
}

async function resolveMedia(
  mediaUrl: string,
  filenameHint?: string,
  signal?: AbortSignal,
): Promise<ResolvedFile> {
  if (mediaUrl.startsWith("data:")) {
    const match = mediaUrl.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/);
    if (!match) throw new Error("Invalid data URI format");
    const contentType = match[1] || "application/octet-stream";
    const buf = Buffer.from(match[2], "base64");
    if (buf.length > MAX_UPLOAD_SIZE) {
      throw new Error(`File too large (${buf.length} bytes, max ${MAX_UPLOAD_SIZE})`);
    }
    const extMap: Record<string, string> = {
      "text/markdown": ".md", "text/plain": ".txt", "application/pdf": ".pdf",
      "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
      "application/json": ".json", "application/zip": ".zip",
      "audio/mpeg": ".mp3", "video/mp4": ".mp4",
    };
    const ext = extMap[contentType] ?? ".bin";
    const filename = filenameHint ?? `file${ext}`;
    return { fileBody: buf, fileSize: buf.length, contentType, filename };
  }

  if (mediaUrl.startsWith("file://")) {
    const filePath = decodeURIComponent(mediaUrl.slice(7));
    const st = statSync(filePath);
    if (st.size > MAX_UPLOAD_SIZE) {
      throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD_SIZE})`);
    }
    const filename = filenameHint ?? path.basename(filePath);
    const contentType = inferContentType(filename);
    return {
      fileBody: createReadStream(filePath),
      fileSize: st.size,
      contentType,
      filename,
      localFilePath: filePath,
    };
  }

  // HTTP(S) — download to temp file.
  const urlPath = new URL(mediaUrl).pathname;
  const rawFilename = path.basename(urlPath) || "file";
  let filename: string;
  try {
    filename = filenameHint ?? decodeURIComponent(rawFilename);
  } catch {
    filename = filenameHint ?? rawFilename;
  }
  const dl = await downloadToTempFile(mediaUrl, filename, signal);
  let contentType = dl.contentType;
  if (!contentType || contentType === "application/octet-stream") {
    contentType = inferContentType(filename);
  }
  const st = statSync(dl.tempPath);
  if (st.size > MAX_UPLOAD_SIZE) {
    await unlink(dl.tempPath).catch(() => {});
    throw new Error(`File too large (${st.size} bytes, max ${MAX_UPLOAD_SIZE})`);
  }
  return {
    fileBody: createReadStream(dl.tempPath),
    fileSize: st.size,
    contentType,
    filename,
    tempPath: dl.tempPath,
    localFilePath: dl.tempPath,
  };
}

/**
 * End-to-end media send: resolve URL → upload to COS → sendMediaMessage.
 *
 * Returns the SendMessageResult from sendMediaMessage. Temp files are
 * cleaned up before return.
 */
export async function uploadAndSendMedia(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  mediaUrl: string;
  filename?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const resolved = await resolveMedia(params.mediaUrl, params.filename, params.signal);
  let result: SendMessageResult | undefined;
  try {
    const creds = await getUploadCredentials({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      filename: resolved.filename,
      signal: params.signal,
    });
    const { url: cdnUrl } = await uploadFileToCOS({
      credentials: creds.credentials,
      startTime: creds.startTime,
      expiredTime: creds.expiredTime,
      bucket: creds.bucket,
      region: creds.region,
      key: creds.key,
      fileBody: resolved.fileBody,
      fileSize: resolved.fileSize,
      contentType: ensureTextCharset(resolved.contentType),
      cdnBaseUrl: creds.cdnBaseUrl,
      filename: resolved.filename,
    });

    const msgType = resolved.contentType.startsWith("image/")
      ? MessageType.Image
      : MessageType.File;

    if (msgType === MessageType.Image) {
      const dims = resolved.localFilePath
        ? await parseImageDimensionsFromFile(resolved.localFilePath, resolved.contentType)
        : Buffer.isBuffer(resolved.fileBody)
          ? parseImageDimensions(resolved.fileBody, resolved.contentType)
          : null;
      result = await sendMediaMessage({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        channelId: params.channelId,
        channelType: params.channelType,
        type: msgType,
        url: cdnUrl,
        width: dims?.width,
        height: dims?.height,
        name: resolved.filename,
        size: resolved.fileSize,
      });
    } else {
      result = await sendMediaMessage({
        apiUrl: params.apiUrl,
        botToken: params.botToken,
        channelId: params.channelId,
        channelType: params.channelType,
        type: msgType,
        url: cdnUrl,
        name: resolved.filename,
        size: resolved.fileSize,
      });
    }
  } finally {
    if (resolved.tempPath) await unlink(resolved.tempPath).catch(() => {});
  }
  return result;
}

// ─── G6: RichText combined send (markdown ![alt](url) → type=14 payload) ───

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

interface UploadedImage {
  url: string;
  cdnUrl: string;
  width: number;
  height: number;
}

interface MarkdownImageRef {
  alt: string;
  url: string;
  offset: number;
  length: number;
}

function findMarkdownImages(text: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  const pattern = new RegExp(MARKDOWN_IMAGE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    refs.push({
      alt: match[1],
      url: match[2],
      offset: match.index,
      length: match[0].length,
    });
  }
  return refs;
}

async function uploadImageForRichText(
  apiUrl: string,
  botToken: string,
  mediaUrl: string,
  signal?: AbortSignal,
): Promise<UploadedImage> {
  const resolved = await resolveMedia(mediaUrl, undefined, signal);
  try {
    if (!resolved.contentType.startsWith("image/")) {
      throw new Error(`Not an image: ${resolved.contentType}`);
    }
    const creds = await getUploadCredentials({
      apiUrl, botToken, filename: resolved.filename, signal,
    });
    const { url: cdnUrl } = await uploadFileToCOS({
      credentials: creds.credentials,
      startTime: creds.startTime,
      expiredTime: creds.expiredTime,
      bucket: creds.bucket,
      region: creds.region,
      key: creds.key,
      fileBody: resolved.fileBody,
      fileSize: resolved.fileSize,
      contentType: ensureTextCharset(resolved.contentType),
      cdnBaseUrl: creds.cdnBaseUrl,
      filename: resolved.filename,
    });
    const dims = resolved.localFilePath
      ? await parseImageDimensionsFromFile(resolved.localFilePath, resolved.contentType)
      : Buffer.isBuffer(resolved.fileBody)
        ? parseImageDimensions(resolved.fileBody, resolved.contentType)
        : null;
    return {
      url: mediaUrl,
      cdnUrl,
      // Default to a reasonable placeholder when dimensions can't be parsed —
      // server requires width/height > 0.
      width: dims?.width ?? 800,
      height: dims?.height ?? 600,
    };
  } finally {
    if (resolved.tempPath) await unlink(resolved.tempPath).catch(() => {});
  }
}

/**
 * Send a text+images combined RichText message in one HTTP call.
 *
 * Parses markdown image references `![alt](url)` from text, uploads each image
 * to COS, then assembles a single type=14 RichText payload with interleaved
 * text and image blocks.
 *
 * On failure: returns `richText: false` to signal the caller should fall back
 * to plain text sendMessage. Partial failures (some images succeed, some fail)
 * still produce a RichText payload with failed images replaced by `[alt]` text.
 */
export async function sendRichTextCombined(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  text: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  signal?: AbortSignal;
}): Promise<{
  messageId?: string;
  imageCount: number;
  failedMedia: Array<{ url: string; error: string }>;
  richText: boolean;
}> {
  const imageRefs = findMarkdownImages(params.text);
  if (imageRefs.length === 0) {
    return { imageCount: 0, failedMedia: [], richText: false };
  }

  const uploaded: Map<number, UploadedImage> = new Map(); // ref index → uploaded
  const failedMedia: Array<{ url: string; error: string }> = [];

  // Upload images in parallel (bounded — N typically small for one reply).
  await Promise.all(imageRefs.map(async (ref, idx) => {
    try {
      const up = await uploadImageForRichText(
        params.apiUrl, params.botToken, ref.url, params.signal,
      );
      uploaded.set(idx, up);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failedMedia.push({ url: ref.url, error: errMsg });
    }
  }));

  if (uploaded.size === 0) {
    // All images failed — caller should fall back to plain text.
    return { imageCount: 0, failedMedia, richText: false };
  }

  // Assemble blocks by walking text + image refs in order.
  const blocks: RichTextBlock[] = [];
  let cursor = 0;
  for (let i = 0; i < imageRefs.length; i++) {
    const ref = imageRefs[i];
    // Text before the image
    const before = params.text.substring(cursor, ref.offset);
    // For failed images, inject [alt] back into text portion.
    let segment = before;
    if (!uploaded.has(i)) {
      segment += `[${ref.alt || 'image'}]`;
    }
    if (segment) {
      blocks.push({ type: RICH_TEXT_BLOCK_TEXT, text: segment });
    }
    const up = uploaded.get(i);
    if (up) {
      blocks.push({
        type: RICH_TEXT_BLOCK_IMAGE,
        url: up.cdnUrl,
        width: up.width,
        height: up.height,
      });
    }
    cursor = ref.offset + ref.length;
  }
  // Trailing text after the last image
  const trailing = params.text.substring(cursor);
  if (trailing) {
    blocks.push({ type: RICH_TEXT_BLOCK_TEXT, text: trailing });
  }

  // Build plain version: original text with images replaced by placeholder.
  const plain = params.text.replace(MARKDOWN_IMAGE_RE, RICH_TEXT_IMAGE_PLACEHOLDER);

  const sendResult = await sendRichTextMessage({
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    channelId: params.channelId,
    channelType: params.channelType,
    blocks,
    plain,
    ...(params.mentionUids ? { mentionUids: params.mentionUids } : {}),
    ...(params.mentionEntities ? { mentionEntities: params.mentionEntities } : {}),
    ...(params.mentionAll ? { mentionAll: true } : {}),
    signal: params.signal,
  });

  return {
    messageId: sendResult?.message_id ? String(sendResult.message_id) : undefined,
    imageCount: uploaded.size,
    failedMedia,
    richText: true,
  };
}

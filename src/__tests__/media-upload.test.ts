/**
 * Tests for media-upload — content type inference, image dimensions, upload pipeline.
 *
 * DNS isolation: downloadToTempFile calls assertPublicUrl which does a DNS
 * lookup for non-IP hosts. Test URLs use fictitious `example.com` hostnames —
 * without DNS mock these hit the real resolver and fail in CI (ENOTFOUND).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname.includes('example.com')) {
      return [{ address: '203.0.113.42', family: 4 }];
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));

// Mock cos-nodejs-sdk-v5 BEFORE any imports of media-upload.
const cosPutObjectMock = vi.fn();
vi.mock('cos-nodejs-sdk-v5', () => ({
  default: vi.fn().mockImplementation(() => ({
    putObject: cosPutObjectMock,
  })),
}));

// Mock global fetch for HEAD/GET in downloadToTempFile and getUploadCredentials.
const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  cosPutObjectMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

import {
  inferContentType,
  ensureTextCharset,
  parseImageDimensions,
  parseImageDimensionsFromFile,
  uploadAndSendMedia,
} from '../media-upload.js';
import { ChannelType } from '../octo/types.js';

// ─── inferContentType ──────────────────────────────────────────────────────

describe('inferContentType', () => {
  it('recognizes known image extensions', () => {
    expect(inferContentType('photo.png')).toBe('image/png');
    expect(inferContentType('photo.jpg')).toBe('image/jpeg');
    expect(inferContentType('photo.JPEG')).toBe('image/jpeg');
    expect(inferContentType('anim.gif')).toBe('image/gif');
    expect(inferContentType('icon.webp')).toBe('image/webp');
  });

  it('recognizes documents and text', () => {
    expect(inferContentType('doc.pdf')).toBe('application/pdf');
    expect(inferContentType('notes.md')).toBe('text/markdown');
    expect(inferContentType('data.json')).toBe('application/json');
    expect(inferContentType('readme.txt')).toBe('text/plain');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(inferContentType('mystery.xyz')).toBe('application/octet-stream');
    expect(inferContentType('noext')).toBe('application/octet-stream');
  });
});

// ─── ensureTextCharset ─────────────────────────────────────────────────────

describe('ensureTextCharset', () => {
  it('appends charset to text/* when missing', () => {
    expect(ensureTextCharset('text/plain')).toBe('text/plain; charset=utf-8');
    expect(ensureTextCharset('text/markdown')).toBe('text/markdown; charset=utf-8');
  });

  it('leaves text/* with existing charset untouched', () => {
    expect(ensureTextCharset('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(ensureTextCharset('text/html; charset=gbk')).toBe('text/html; charset=gbk');
  });

  it('leaves non-text types unchanged', () => {
    expect(ensureTextCharset('application/json')).toBe('application/json');
    expect(ensureTextCharset('image/png')).toBe('image/png');
  });
});

// ─── parseImageDimensions ──────────────────────────────────────────────────

describe('parseImageDimensions', () => {
  it('parses PNG dimensions from header', () => {
    // Minimal PNG: 8-byte signature + IHDR chunk (4 length + 4 type + 13 data + 4 crc)
    const buf = Buffer.alloc(33);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
    buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
    // IHDR length (13)
    buf.writeUInt32BE(13, 8);
    // "IHDR"
    buf.write('IHDR', 12);
    // Width at offset 16, height at offset 20
    buf.writeUInt32BE(640, 16);
    buf.writeUInt32BE(480, 20);

    const result = parseImageDimensions(buf, 'image/png');
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('parses GIF dimensions from header', () => {
    const buf = Buffer.alloc(13);
    // GIF89a header
    buf.write('GIF89a', 0);
    // Width LE at offset 6, height LE at offset 8
    buf.writeUInt16LE(320, 6);
    buf.writeUInt16LE(240, 8);

    const result = parseImageDimensions(buf, 'image/gif');
    expect(result).toEqual({ width: 320, height: 240 });
  });

  it('returns null for malformed PNG', () => {
    const buf = Buffer.alloc(8); // too short
    expect(parseImageDimensions(buf, 'image/png')).toBeNull();
  });

  it('returns null for unsupported mime', () => {
    const buf = Buffer.alloc(100);
    expect(parseImageDimensions(buf, 'image/tiff')).toBeNull();
  });

  // Q1-1: JPEG SOF marker scan. Production scans for 0xFFC0/0xFFC2 markers,
  // reads height at offset+5 and width at offset+7 (both 2 bytes BE).
  // Pre-Q1 this code path was entirely untested; a parse failure silently
  // falls back to 800x600 defaults in uploadImageForRichText.
  it('parses JPEG dimensions via SOF0 marker', () => {
    // Minimal JPEG: SOI (FFD8) + APP0 segment + SOF0 segment.
    const buf = Buffer.alloc(40);
    // SOI
    buf[0] = 0xFF; buf[1] = 0xD8;
    // APP0 marker at offset 2
    buf[2] = 0xFF; buf[3] = 0xE0;
    // APP0 segment length: 16 bytes (includes the length field itself)
    buf.writeUInt16BE(16, 4);
    // SOF0 marker at offset 20 (2 marker + 2 + 16 APP0 segment = offset 20)
    buf[20] = 0xFF; buf[21] = 0xC0;
    // SOF0 segment length: 17 bytes
    buf.writeUInt16BE(17, 22);
    // SOF0 data layout: precision (1) + height (2 BE) + width (2 BE) + ...
    buf[24] = 8;                  // precision (offset+4 from marker start)
    buf.writeUInt16BE(720, 25);  // height at offset 25 (= marker+5)
    buf.writeUInt16BE(1280, 27); // width at offset 27 (= marker+7)
    const result = parseImageDimensions(buf, 'image/jpeg');
    expect(result).toEqual({ width: 1280, height: 720 });
  });

  it('parses JPEG dimensions via SOF2 marker (progressive)', () => {
    // Same shape but using SOF2 (0xFFC2) instead of SOF0.
    const buf = Buffer.alloc(40);
    buf[0] = 0xFF; buf[1] = 0xD8;
    buf[2] = 0xFF; buf[3] = 0xE0;
    buf.writeUInt16BE(16, 4);
    buf[20] = 0xFF; buf[21] = 0xC2; // SOF2
    buf.writeUInt16BE(17, 22);
    buf[24] = 8;
    buf.writeUInt16BE(480, 25);  // height
    buf.writeUInt16BE(640, 27);  // width
    const result = parseImageDimensions(buf, 'image/jpeg');
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('accepts image/jpg mime alias for JPEG (some uploads use .jpg → image/jpg)', () => {
    const buf = Buffer.alloc(40);
    buf[0] = 0xFF; buf[1] = 0xD8;
    buf[2] = 0xFF; buf[3] = 0xE0;
    buf.writeUInt16BE(16, 4);
    buf[20] = 0xFF; buf[21] = 0xC0;
    buf.writeUInt16BE(17, 22);
    buf[24] = 8;
    buf.writeUInt16BE(100, 25);
    buf.writeUInt16BE(200, 27);
    const result = parseImageDimensions(buf, 'image/jpg');
    expect(result).toEqual({ width: 200, height: 100 });
  });

  it('returns null for JPEG with no SOF marker (truncated after SOI)', () => {
    // SOI only, no SOF marker reachable before end of buffer
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    expect(parseImageDimensions(buf, 'image/jpeg')).toBeNull();
  });

  // Q1-1: WebP VP8 RIFF header. Production checks `VP8 ` (with trailing
  // space) at offset 12-16, then reads width/height as 2-byte LE with
  // 0x3FFF mask. The mask is a VP8 quirk; wrong mask = wrong dimensions.
  it('parses WebP VP8 dimensions from RIFF header', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(32, 4);   // file size minus 8
    buf.write('WEBP', 8);
    buf.write('VP8 ', 12);      // VP8 chunk fourcc (with trailing space!)
    buf.writeUInt32LE(20, 16);  // VP8 chunk size
    // VP8 bitstream: 6-byte tag/keyframe (offsets 20-25) we don't validate,
    // then width at offset 26 (2 LE), height at offset 28 (2 LE), both masked 0x3FFF.
    buf.writeUInt16LE(640, 26);
    buf.writeUInt16LE(480, 28);
    const result = parseImageDimensions(buf, 'image/webp');
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('applies 0x3FFF mask to WebP VP8 dimensions (high bits = scaling, not dim)', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(32, 4);
    buf.write('WEBP', 8);
    buf.write('VP8 ', 12);
    buf.writeUInt32LE(20, 16);
    // Set high bits (scaling flags in VP8) that must be masked OUT.
    buf.writeUInt16LE(640 | 0xC000, 26);  // raw value 0xC280, masked = 0x0280 = 640
    buf.writeUInt16LE(480 | 0xC000, 28);  // raw value 0xC1E0, masked = 0x01E0 = 480
    const result = parseImageDimensions(buf, 'image/webp');
    // Mask must drop top 2 bits.
    expect(result).toEqual({ width: 640, height: 480 });
  });

  it('returns null for WebP with missing VP8 chunk marker', () => {
    const buf = Buffer.alloc(40);
    buf.write('RIFF', 0);
    buf.write('WEBP', 8);
    buf.write('VP8L', 12); // VP8L (lossless) not handled by current parser → null
    expect(parseImageDimensions(buf, 'image/webp')).toBeNull();
  });
});

describe('parseImageDimensionsFromFile', () => {
  it('reads PNG dimensions from disk file', async () => {
    const tmpDir = path.join(tmpdir(), 'cc-octo-test');
    await mkdir(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `test-${Date.now()}.png`);

    // Build a real PNG header
    const buf = Buffer.alloc(33);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
    buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12);
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);

    try {
      await writeFile(filePath, buf);
      const result = await parseImageDimensionsFromFile(filePath, 'image/png');
      expect(result).toEqual({ width: 1920, height: 1080 });
    } finally {
      await unlink(filePath).catch(() => {});
    }
  });

  it('returns null for non-existent file', async () => {
    const result = await parseImageDimensionsFromFile('/nonexistent/file.png', 'image/png');
    expect(result).toBeNull();
  });
});

// ─── uploadAndSendMedia ────────────────────────────────────────────────────

describe('uploadAndSendMedia', () => {
  it('happy path: data URI image → COS upload → sendMediaMessage', async () => {
    // Mock getUploadCredentials response
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      bucket: 'b', region: 'r', key: 'path/img.png',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 4600,
      cdnBaseUrl: 'https://cdn.example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    // Mock COS putObject
    cosPutObjectMock.mockImplementation((_params, cb) => {
      cb(null, { Location: 'b.cos.r.myqcloud.com/path/img.png' });
    });

    // Mock sendMediaMessage response
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    // Build a tiny PNG (33 bytes) and encode as data URI
    const png = Buffer.alloc(33);
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4E; png[3] = 0x47;
    png[4] = 0x0D; png[5] = 0x0A; png[6] = 0x1A; png[7] = 0x0A;
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(8, 16);
    png.writeUInt32BE(8, 20);
    const dataUri = `data:image/png;base64,${png.toString('base64')}`;

    const result = await uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: dataUri,
    });

    expect(result?.message_id).toBe('m1');
    expect(cosPutObjectMock).toHaveBeenCalledTimes(1);

    // Verify sendMediaMessage was called with Image type and parsed dimensions
    const sendCall = fetchMock.mock.calls[1];
    const sendBody = JSON.parse(sendCall[1].body as string);
    expect(sendBody.payload.type).toBe(2); // Image
    expect(sendBody.payload.url).toBe('https://cdn.example.com/path/img.png');
    expect(sendBody.payload.width).toBe(8);
    expect(sendBody.payload.height).toBe(8);
  });

  it('rejects data URI with invalid format', async () => {
    await expect(uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: 'data:malformed',
    })).rejects.toThrow(/Invalid data URI/);
  });

  it('rejects file too large (data URI)', async () => {
    // 501MB buffer encoded as base64 would be huge; cheap proxy: mock a fake-but-tiny
    // base64 that decodes to >500MB. Instead use a real check: data URI with declared
    // huge content. We approximate with a real >500MB buffer (tiny test alternative:
    // pass a mediaUrl that triggers HEAD content-length > MAX).
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 200,
      headers: { 'content-length': String(600 * 1024 * 1024) },
    }));

    await expect(uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: 'https://example.com/huge.bin',
    })).rejects.toThrow(/File too large/);
  });

  it('treats non-image as File type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      bucket: 'b', region: 'r', key: 'path/doc.pdf',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 4600,
      cdnBaseUrl: 'https://cdn.example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    cosPutObjectMock.mockImplementation((_params, cb) => {
      cb(null, { Location: 'b.cos.r.myqcloud.com/path/doc.pdf' });
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      message_id: 'm1', client_msg_no: 'c1', message_seq: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const dataUri = `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`;
    const result = await uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: dataUri,
    });

    expect(result?.message_id).toBe('m1');
    const sendBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(sendBody.payload.type).toBe(8); // File
    expect(sendBody.payload.width).toBeUndefined();
    expect(sendBody.payload.height).toBeUndefined();
  });

  it('rejects file:// URLs entirely (P0.1 security)', async () => {
    await expect(uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: 'file:///etc/passwd',
    })).rejects.toThrow(/file:\/\/ URLs are not allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cosPutObjectMock).not.toHaveBeenCalled();
  });

  it.each([
    ['http://127.0.0.1/x.png', /127\.0\.0\.1/],
    ['http://169.254.169.254/latest/meta-data/', /169\.254\.169\.254/],
    ['http://10.0.0.1/internal', /10\.0\.0\.1/],
    ['http://172.16.5.5/internal', /172\.16\.5\.5/],
    ['http://192.168.1.1/admin', /192\.168\.1\.1/],
    ['http://100.100.0.1/cgn', /100\.100\.0\.1/],
    ['http://[::1]/loopback', /::1/],
    ['http://[fc00::1]/ula', /fc00::1/],
    ['http://[fe80::1]/linklocal', /fe80::1/],
  ])('rejects SSRF target %s (P0.2 security)', async (url, msgPattern) => {
    await expect(uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: url,
    })).rejects.toThrow(msgPattern);
    // assertPublicUrl runs BEFORE HEAD — no HTTP call should be made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects propagates COS upload errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      bucket: 'b', region: 'r', key: 'path/x.png',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 4600,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    cosPutObjectMock.mockImplementation((_params, cb) => {
      cb(new Error('Network down'), null);
    });

    const dataUri = `data:image/png;base64,${Buffer.from('fake').toString('base64')}`;
    await expect(uploadAndSendMedia({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      mediaUrl: dataUri,
    })).rejects.toThrow(/COS upload failed.*Network down/);
  });
});

// Restore fetch after all tests
import { afterAll } from 'vitest';
afterAll(() => { globalThis.fetch = originalFetch; });

// ─── G6: sendRichTextCombined ──────────────────────────────────────────────

import { sendRichTextCombined } from '../media-upload.js';

describe('sendRichTextCombined', () => {
  it('text only (no markdown images) → richText: false', async () => {
    const result = await sendRichTextCombined({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      text: 'plain text without any images',
    });
    expect(result.richText).toBe(false);
    expect(result.imageCount).toBe(0);
    expect(result.failedMedia).toEqual([]);
    // No HTTP calls should have been made
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cosPutObjectMock).not.toHaveBeenCalled();
  });

  it('1 image + text → assembles correct blocks + sends type=14', async () => {
    // Build a tiny PNG data URI to avoid HTTP download path
    const png = Buffer.alloc(33);
    png[0] = 0x89; png[1] = 0x50; png[2] = 0x4E; png[3] = 0x47;
    png[4] = 0x0D; png[5] = 0x0A; png[6] = 0x1A; png[7] = 0x0A;
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12);
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(80, 20);
    const dataUri = `data:image/png;base64,${png.toString('base64')}`;

    // Mock: getUploadCredentials response
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      bucket: 'b', region: 'r', key: 'path/img.png',
      credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' },
      startTime: 1, expiredTime: 4600,
      cdnBaseUrl: 'https://cdn.example.com',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    cosPutObjectMock.mockImplementation((_params, cb) => {
      cb(null, { Location: 'b.cos.r.myqcloud.com/path/img.png' });
    });

    // Mock: sendRichTextMessage response
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      message_id: 'rt1', client_msg_no: 'c1', message_seq: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await sendRichTextCombined({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      text: `Before ![cat](${dataUri}) after`,
    });

    expect(result.richText).toBe(true);
    expect(result.imageCount).toBe(1);
    expect(result.messageId).toBe('rt1');
    expect(result.failedMedia).toEqual([]);

    // Verify the type=14 send payload
    const sendCall = fetchMock.mock.calls[1];
    const sendBody = JSON.parse(sendCall[1].body as string);
    expect(sendBody.payload.type).toBe(14);
    expect(sendBody.payload.content).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'image', url: 'https://cdn.example.com/path/img.png', width: 100, height: 80 },
      { type: 'text', text: ' after' },
    ]);
    expect(sendBody.payload.plain).toContain('[图片]');
  });

  it('all images failed → richText: false', async () => {
    // Mock: getUploadCredentials throws
    fetchMock.mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }));

    const dataUri = `data:image/png;base64,${Buffer.from('not a real png').toString('base64')}`;
    const result = await sendRichTextCombined({
      apiUrl: 'https://test.example.com',
      botToken: 'bf_test',
      channelId: 'ch1',
      channelType: ChannelType.Group,
      text: `text with ![alt](${dataUri})`,
    });

    expect(result.richText).toBe(false);
    expect(result.imageCount).toBe(0);
    expect(result.failedMedia).toHaveLength(1);
  });
});

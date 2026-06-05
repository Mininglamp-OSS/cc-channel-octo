/**
 * Inbound message resolver tests — G1, G2, G11, G22 coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveContent,
  resolveRichTextContent,
  resolveMultipleForwardText,
  resolveHistoricalMessagePlaceholder,
  buildMediaUrl,
  TEXT_FILE_EXTENSIONS,
  INLINE_FILE_MAX_BYTES,
} from '../inbound.js';
import { MessageType, RICH_TEXT_BLOCK_IMAGE, RICH_TEXT_BLOCK_TEXT } from '../octo/types.js';
import type { MessagePayload } from '../octo/types.js';

const API_URL = 'https://api.example.com';

// --- buildMediaUrl ---

describe('buildMediaUrl', () => {
  it('returns undefined for missing url', () => {
    expect(buildMediaUrl(undefined, API_URL)).toBeUndefined();
    expect(buildMediaUrl('', API_URL)).toBeUndefined();
  });

  it('only passes through absolute http(s) URLs when host matches apiUrl (S1)', () => {
    // Same host — allowed
    expect(buildMediaUrl('https://api.example.com/file/x.jpg', API_URL))
      .toBe('https://api.example.com/file/x.jpg');
    // Different host — rejected (was the SSRF + botToken leak vector)
    expect(buildMediaUrl('https://cdn.x.com/a.jpg', API_URL)).toBeUndefined();
    expect(buildMediaUrl('http://attacker.com/log', API_URL)).toBeUndefined();
    expect(buildMediaUrl('http://169.254.169.254/meta', API_URL)).toBeUndefined();
  });

  it('rejects protocol downgrade (https apiUrl + http target)', () => {
    expect(buildMediaUrl('http://api.example.com/file/x.jpg', API_URL)).toBeUndefined();
  });

  it('strips file/preview/ prefix', () => {
    expect(buildMediaUrl('file/preview/123/img.png', API_URL))
      .toBe('https://api.example.com/file/123/img.png');
  });

  it('strips file/ prefix', () => {
    expect(buildMediaUrl('file/abc/img.png', API_URL))
      .toBe('https://api.example.com/file/abc/img.png');
  });

  it('handles raw storage path', () => {
    expect(buildMediaUrl('abc/img.png', API_URL))
      .toBe('https://api.example.com/file/abc/img.png');
  });

  // ─── S1 + P1.2 path traversal + smuggling defense ───────────────

  it.each([
    ['../v1/admin'],
    ['file/../v1/admin'],
    ['../../etc/passwd'],
    ['file/a/../../v1/admin'],
    ['./hidden'],
  ])('rejects path traversal: %s', (input) => {
    expect(buildMediaUrl(input, API_URL)).toBeUndefined();
  });

  it('rejects scheme-relative URL (//attacker.com)', () => {
    expect(buildMediaUrl('//attacker.com/log', API_URL)).toBeUndefined();
  });

  it('rejects backslash injection (Windows-style traversal)', () => {
    expect(buildMediaUrl('a\\..\\v1\\admin', API_URL)).toBeUndefined();
    expect(buildMediaUrl('file\\backslash', API_URL)).toBeUndefined();
  });

  it('rejects leading-slash relative path (avoids double-slash output)', () => {
    expect(buildMediaUrl('/abs/path/x.png', API_URL)).toBeUndefined();
  });
});

// --- resolveContent (G1) ---

describe('resolveContent: Text', () => {
  it('returns plain content for text', () => {
    const r = resolveContent({ type: MessageType.Text, content: 'hello' }, API_URL);
    expect(r.text).toBe('hello');
    expect(r.mediaUrl).toBeUndefined();
  });

  it('handles missing content', () => {
    const r = resolveContent({ type: MessageType.Text }, API_URL);
    expect(r.text).toBe('');
  });
});

describe('resolveContent: Image', () => {
  it('renders image with URL marker', () => {
    const r = resolveContent({ type: MessageType.Image, url: 'file/abc.jpg' }, API_URL);
    expect(r.text).toBe('[图片]\nhttps://api.example.com/file/abc.jpg');
    expect(r.mediaUrl).toBe('https://api.example.com/file/abc.jpg');
  });

  it('renders image without URL gracefully', () => {
    const r = resolveContent({ type: MessageType.Image }, API_URL);
    expect(r.text).toBe('[图片]');
    expect(r.mediaUrl).toBeUndefined();
  });
});

describe('resolveContent: GIF / Voice / Video / File', () => {
  it('GIF', () => {
    const r = resolveContent({ type: MessageType.GIF, url: 'file/x.gif' }, API_URL);
    expect(r.text).toContain('[GIF]');
    expect(r.text).toContain('x.gif');
  });

  it('Voice (G22: URL marker only, transcription TBD)', () => {
    const r = resolveContent({ type: MessageType.Voice, url: 'file/x.mp3' }, API_URL);
    expect(r.text).toContain('[语音消息]');
    expect(r.text).toContain('x.mp3');
    expect(r.mediaUrl).toBeDefined();
  });

  it('Video', () => {
    const r = resolveContent({ type: MessageType.Video, url: 'file/x.mp4' }, API_URL);
    expect(r.text).toContain('[视频]');
    expect(r.text).toContain('x.mp4');
  });

  it('File with name', () => {
    const r = resolveContent({ type: MessageType.File, url: 'file/x.pdf', name: 'report.pdf' }, API_URL);
    expect(r.text).toContain('[文件: report.pdf]');
    expect(r.text).toContain('x.pdf');
  });

  it('File without name uses placeholder', () => {
    const r = resolveContent({ type: MessageType.File, url: 'file/x.pdf' }, API_URL);
    expect(r.text).toContain('[文件: 未知文件]');
  });
});

describe('resolveContent: Location', () => {
  it('renders coordinates when present', () => {
    const r = resolveContent(
      { type: MessageType.Location, latitude: 31.23, longitude: 121.47 } as unknown as MessagePayload,
      API_URL,
    );
    expect(r.text).toBe('[位置信息: 31.23,121.47]');
  });

  it('renders placeholder without coordinates', () => {
    const r = resolveContent({ type: MessageType.Location }, API_URL);
    expect(r.text).toBe('[位置信息]');
  });
});

describe('resolveContent: Card', () => {
  it('renders name + uid', () => {
    const r = resolveContent(
      { type: MessageType.Card, name: 'Alice', uid: 'u-alice' } as unknown as MessagePayload,
      API_URL,
    );
    expect(r.text).toBe('[名片: Alice (u-alice)]');
  });

  it('renders name only', () => {
    const r = resolveContent({ type: MessageType.Card, name: 'Bob' } as unknown as MessagePayload, API_URL);
    expect(r.text).toBe('[名片: Bob]');
  });
});

describe('resolveContent: RichText (type=14)', () => {
  it('expands content blocks to text + collects image URLs', () => {
    const payload = {
      type: MessageType.RichText,
      content: [
        { type: RICH_TEXT_BLOCK_TEXT, text: '看这张图：' },
        { type: RICH_TEXT_BLOCK_IMAGE, url: 'file/img1.png' },
        { type: RICH_TEXT_BLOCK_TEXT, text: '还有这张' },
        { type: RICH_TEXT_BLOCK_IMAGE, url: 'file/img2.jpg' },
      ],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toContain('看这张图：');
    expect(r.text).toContain('还有这张');
    expect(r.mediaUrls).toHaveLength(2);
    expect(r.mediaUrls?.[0]).toContain('img1.png');
    expect(r.mediaUrl).toBe(r.mediaUrls?.[0]);
  });

  it('uses top-level plain when present (server-authoritative)', () => {
    const payload = {
      type: MessageType.RichText,
      plain: 'authoritative plain text',
      content: [{ type: RICH_TEXT_BLOCK_TEXT, text: 'block text' }],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toBe('authoritative plain text');
  });

  it('falls back to block assembly when plain is empty', () => {
    const payload = {
      type: MessageType.RichText,
      plain: '   ',
      content: [{ type: RICH_TEXT_BLOCK_TEXT, text: 'block text' }],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toBe('block text');
  });

  it('handles string content (legacy compat)', () => {
    const payload = {
      type: MessageType.RichText,
      content: 'legacy string content',
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toBe('legacy string content');
  });

  it('skips malformed image url (non-string)', () => {
    const payload = {
      type: MessageType.RichText,
      content: [
        { type: RICH_TEXT_BLOCK_IMAGE, url: { malformed: true } },
        { type: RICH_TEXT_BLOCK_IMAGE, url: 'file/good.png' },
      ],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.mediaUrls).toHaveLength(1);
    expect(r.mediaUrls?.[0]).toContain('good.png');
  });

  it('handles non-string text in text block', () => {
    const payload = {
      type: MessageType.RichText,
      content: [
        { type: RICH_TEXT_BLOCK_TEXT, text: { bad: 'object' } },
        { type: RICH_TEXT_BLOCK_TEXT, text: 'ok' },
      ],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    // Should not produce "[object Object]"
    expect(r.text).not.toContain('[object Object]');
    expect(r.text).toContain('ok');
  });
});

describe('resolveContent: MultipleForward (type=11)', () => {
  it('expands forwarded transcript with user names', () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [
        { uid: 'u1', name: 'Alice' },
        { uid: 'u2', name: 'Bob' },
      ],
      msgs: [
        { from_uid: 'u1', payload: { type: MessageType.Text, content: 'hello' } },
        { from_uid: 'u2', payload: { type: MessageType.Text, content: 'world' } },
        { from_uid: 'u1', payload: { type: MessageType.Image, url: 'file/img.jpg' } },
      ],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toContain('[合并转发: 聊天记录]');
    expect(r.text).toContain('Alice: hello');
    expect(r.text).toContain('Bob: world');
    expect(r.text).toContain('Alice: [图片]');
    expect(r.text).toContain('img.jpg');
  });

  it('handles nested MultipleForward', () => {
    const nested = {
      type: MessageType.MultipleForward,
      users: [{ uid: 'u3', name: 'Carol' }],
      msgs: [{ from_uid: 'u3', payload: { type: MessageType.Text, content: 'inner' } }],
    };
    const payload = {
      type: MessageType.MultipleForward,
      users: [{ uid: 'u1', name: 'Alice' }],
      msgs: [
        { from_uid: 'u1', payload: nested },
      ],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toContain('Alice: [合并转发]');
    expect(r.text).toContain('Carol: inner');
  });

  it('falls back to uid when user name missing', () => {
    const payload = {
      type: MessageType.MultipleForward,
      users: [],
      msgs: [{ from_uid: 'unknown-uid', payload: { type: MessageType.Text, content: 'lone' } }],
    } as unknown as MessagePayload;
    const r = resolveContent(payload, API_URL);
    expect(r.text).toContain('unknown-uid: lone');
  });
});

describe('resolveContent: unknown type', () => {
  it('falls back to content or url', () => {
    const r1 = resolveContent({ type: 999, content: 'fallback' } as unknown as MessagePayload, API_URL);
    expect(r1.text).toBe('fallback');
    const r2 = resolveContent({ type: 999, url: 'https://x.com' } as unknown as MessagePayload, API_URL);
    expect(r2.text).toBe('https://x.com');
    const r3 = resolveContent({ type: 999 } as unknown as MessagePayload, API_URL);
    expect(r3.text).toBe('[消息]');
  });
});

describe('resolveContent: undefined payload', () => {
  it('returns empty text', () => {
    const r = resolveContent(undefined, API_URL);
    expect(r.text).toBe('');
  });
});

// --- resolveHistoricalMessagePlaceholder (G4) ---

describe('resolveHistoricalMessagePlaceholder (G4)', () => {
  it('returns placeholder for each non-text type', () => {
    expect(resolveHistoricalMessagePlaceholder(MessageType.Image)).toBe('[图片]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.GIF)).toBe('[GIF]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.Voice)).toBe('[语音消息]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.Video)).toBe('[视频]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.File, 'doc.pdf')).toBe('[文件: doc.pdf]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.Location)).toBe('[位置信息]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.Card)).toBe('[名片]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.MultipleForward)).toBe('[合并转发]');
    expect(resolveHistoricalMessagePlaceholder(MessageType.RichText)).toBe('[图文消息]');
  });

  it('returns empty for Text (use content directly)', () => {
    expect(resolveHistoricalMessagePlaceholder(MessageType.Text)).toBe('');
  });

  it('returns empty for unknown type', () => {
    expect(resolveHistoricalMessagePlaceholder(undefined)).toBe('');
    expect(resolveHistoricalMessagePlaceholder(999)).toBe('');
  });
});

// --- TEXT_FILE_EXTENSIONS (G2) ---

describe('TEXT_FILE_EXTENSIONS (G2)', () => {
  it('includes common code/text extensions', () => {
    for (const ext of ['py', 'ts', 'js', 'json', 'md', 'csv', 'yaml', 'sh', 'rs', 'go']) {
      expect(TEXT_FILE_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it('excludes binary types', () => {
    for (const ext of ['png', 'jpg', 'pdf', 'zip', 'exe', 'mp4']) {
      expect(TEXT_FILE_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  it('inline cap is 20KB', () => {
    expect(INLINE_FILE_MAX_BYTES).toBe(20 * 1024);
  });
});

// --- Direct helpers ---

describe('resolveRichTextContent', () => {
  it('handles empty payload', () => {
    const r = resolveRichTextContent({}, API_URL);
    expect(r.text).toBe('');
    expect(r.mediaUrls).toEqual([]);
  });
});

describe('resolveMultipleForwardText', () => {
  it('returns header only when msgs empty', () => {
    const r = resolveMultipleForwardText({ users: [], msgs: [] }, API_URL);
    expect(r).toBe('[合并转发: 聊天记录]');
  });
});

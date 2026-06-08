/**
 * Tests for url-policy.ts shared SSRF + URL validation module (S1+S2+S5+S6).
 */

import { describe, it, expect } from 'vitest';
import {
  isPrivateOrLocalAddress,
  assertPublicUrl,
  isAllowedApiUrl,
} from '../url-policy.js';

describe('isPrivateOrLocalAddress (S5 hex v4-mapped fix)', () => {
  // ── IPv4 private ranges ─────────────────────────────────────────
  it.each([
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false], // not in 12-bit private range
    ['192.168.1.1', true],
    ['169.254.169.254', true], // AWS metadata
    ['100.64.0.1', true], // CGN
    ['100.127.255.255', true],
    ['100.128.0.0', false], // outside CGN
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['203.0.113.1', false], // TEST-NET-3 (public for docs but routable)
  ])('IPv4 %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  // ── IPv6 standard ───────────────────────────────────────────────
  it.each([
    ['::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['febf:1234::1', true],
    ['2001:db8::1', false], // documentation prefix, not private
    ['2606:4700:4700::1111', false], // Cloudflare DNS
  ])('IPv6 %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  // ── S5 fix: hex v4-mapped (the actual bypass case) ─────────────
  it.each([
    // dotted-quad form (original PR#34 handled)
    ['::ffff:127.0.0.1', true],
    ['::ffff:169.254.169.254', true],
    ['::ffff:8.8.8.8', false],
    // hex form (PR#34 bypass — S5 fix target)
    ['::ffff:7f00:1', true],        // 127.0.0.1
    ['::ffff:a9fe:a9fe', true],     // 169.254.169.254 AWS metadata
    ['::ffff:c0a8:101', true],      // 192.168.1.1
    ['::ffff:a00:1', true],         // 10.0.0.1
    ['::ffff:0808:0808', false],    // 8.8.8.8
  ])('IPv6 v4-mapped %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  // ── IPv4-compatible IPv6 (deprecated but resolvable) ──────────
  it.each([
    ['::127.0.0.1', true],
    ['::8.8.8.8', false],
    ['::7f00:1', true],
    ['::0808:0808', false],
  ])('IPv4-compatible %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  // ── NAT64 (64:ff9b::/96) embeds an IPv4 in the low 32 bits ────
  it.each([
    ['64:ff9b::7f00:1', true],        // 127.0.0.1
    ['64:ff9b::a9fe:a9fe', true],     // 169.254.169.254 (metadata)
    ['64:ff9b::127.0.0.1', true],     // dotted-quad tail form
    ['64:ff9b::0808:0808', false],    // 8.8.8.8 (public)
    ['64:ff9b::8.8.8.8', false],
  ])('NAT64 %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  // ── 6to4 (2002::/16) embeds an IPv4 in bits 16..47 ────────────
  it.each([
    ['2002:7f00:1::1', true],         // 127.0.0.1
    ['2002:a9fe:a9fe::1', true],      // 169.254.169.254
    ['2002:0808:0808::1', false],     // 8.8.8.8 (public)
  ])('6to4 %s → %s', (addr, expected) => {
    expect(isPrivateOrLocalAddress(addr)).toBe(expected);
  });

  it('returns false for malformed input', () => {
    expect(isPrivateOrLocalAddress('not-an-ip')).toBe(false);
    expect(isPrivateOrLocalAddress('')).toBe(false);
    expect(isPrivateOrLocalAddress('999.999.999.999')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/non-http/);
    await expect(assertPublicUrl('gopher://x/')).rejects.toThrow(/non-http/);
    await expect(assertPublicUrl('ftp://x/')).rejects.toThrow(/non-http/);
    await expect(assertPublicUrl('dict://x/')).rejects.toThrow(/non-http/);
  });

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    // S5 hex v4-mapped forms — these were the PR#34 bypass
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects private IP literal %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(/private\/local/);
  });

  it('allows public IPv4 literal', async () => {
    await expect(assertPublicUrl('http://8.8.8.8/')).resolves.toBeUndefined();
  });

  it('allows public IPv6 literal', async () => {
    await expect(assertPublicUrl('http://[2606:4700:4700::1111]/')).resolves.toBeUndefined();
  });
});

describe('isAllowedApiUrl (S6)', () => {
  it.each([
    // https to public hosts — allowed
    ['https://api.example.com', true],
    ['https://api.example.com:443/v1', true],
    ['https://8.8.8.8/', true],
    // http to localhost — allowed for local dev
    ['http://localhost', true],
    ['http://127.0.0.1', true],
    ['http://[::1]', true],
    // http to any other host — rejected
    ['http://api.example.com', false],
    ['http://8.8.8.8/', false],
    // S6 fix: https to PRIVATE IP — rejected (was allowed before)
    ['https://127.0.0.1/', false],
    ['https://10.0.0.1/', false],
    ['https://169.254.169.254/', false],
    ['https://[::1]/', false],
    ['https://[::ffff:7f00:1]/', false], // S5 hex form
    // wss/ftp/file — rejected
    ['wss://example.com/', false],
    ['file:///etc/passwd', false],
    ['ftp://example.com/', false],
    // malformed — rejected
    ['', false],
    ['not-a-url', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedApiUrl(url)).toBe(expected);
  });
});

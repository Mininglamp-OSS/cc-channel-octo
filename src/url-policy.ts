/**
 * URL policy — shared SSRF defense + URL validation utilities.
 *
 * Stage 6 W1: consolidates URL validation that was previously duplicated and
 * inconsistent across media-upload.ts, inbound.ts, and config.ts.
 *
 * Three public surfaces:
 *   - isPrivateOrLocalAddress(address): IP-range check (IPv4 + IPv6 + v4-mapped)
 *   - assertPublicUrl(url): throws if a URL resolves to a private/local address
 *   - fetchWithRedirectGuard(url, init): fetch() wrapper that re-validates on every redirect
 *   - isAllowedApiUrl(url): boot-time apiUrl validation (https any non-private host, http localhost only)
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Reject IP literals/resolved IPs in private/loopback/link-local/CGN ranges.
 *
 * Covers IPv4 + IPv6 forms including:
 *   - IPv6 dotted-quad v4-mapped: `::ffff:127.0.0.1`
 *   - IPv6 hex v4-mapped: `::ffff:7f00:1` (S5 — was a bypass of original PR#34 fix)
 *   - IPv4-compatible IPv6: `::7f00:1` (deprecated but resolvable)
 *
 * NOTE: DNS rebinding remains a residual risk. We validate at lookup time;
 * the OS resolver may return a different IP at fetch time. Mitigated by short
 * TTLs and the fact that an attacker would need to control authoritative DNS
 * for a domain we trust. For full protection, callers can pin IP and connect
 * by IP — not done here to preserve TLS SNI and CDN routing.
 */
export function isPrivateOrLocalAddress(address: string): boolean {
  const fam = isIP(address);
  if (fam === 4) {
    return isPrivateIPv4(address);
  }
  if (fam === 6) {
    const lower = address.toLowerCase();
    // ::1 loopback
    if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
    // :: unspecified
    if (lower === "::" || lower === "0:0:0:0:0:0:0:0") return true;
    // fc00::/7 unique local addresses (fc.. and fd..)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 link-local (fe80..febf)
    if (
      lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")
    ) return true;
    // S5 fix: ::ffff:<v4-mapped> — both dotted-quad AND hex forms.
    // URL.hostname normalizes `::ffff:127.0.0.1` → `::ffff:7f00:1` so a regex
    // matching only the dotted-quad form (original PR#34 implementation) was
    // bypassable. Cover both representations.
    const v4MappedDot = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4MappedDot) return isPrivateIPv4(v4MappedDot[1]);
    const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
      const high = parseInt(v4MappedHex[1], 16);
      const low = parseInt(v4MappedHex[2], 16);
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIPv4(dotted);
    }
    // IPv4-compatible IPv6: `::a.b.c.d` (deprecated form, but resolvable).
    const v4CompatDot = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (v4CompatDot) return isPrivateIPv4(v4CompatDot[1]);
    // IPv4-compatible IPv6 hex form: `::a:b` where a:b decodes to dotted-quad.
    const v4CompatHex = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4CompatHex) {
      const high = parseInt(v4CompatHex[1], 16);
      const low = parseInt(v4CompatHex[2], 16);
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIPv4(dotted);
    }
    // NAT64 well-known prefix 64:ff9b::/96 — the last 32 bits embed an IPv4
    // address. A name resolving to e.g. `64:ff9b::7f00:1` (= 127.0.0.1) on a
    // NAT64-enabled host would otherwise reach loopback. The embedded v4 is the
    // final two hextets (dotted-quad form `64:ff9b::a.b.c.d` is also accepted).
    if (lower.startsWith("64:ff9b:")) {
      const dotTail = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
      if (dotTail) return isPrivateIPv4(dotTail[1]);
      const hexTail = lower.match(/:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexTail) {
        const embedded = decodeEmbeddedV4(hexTail[1], hexTail[2]);
        if (embedded) return isPrivateIPv4(embedded);
      }
    }
    // 6to4 2002::/16 — bits 16..47 embed an IPv4 address (2002:V4hi:V4lo::/48).
    const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
    if (sixToFour) {
      const embedded = decodeEmbeddedV4(sixToFour[1], sixToFour[2]);
      if (embedded && isPrivateIPv4(embedded)) return true;
    }
    return false;
  }
  // Not a valid IP literal — caller should resolve via DNS first.
  return false;
}

/** Decode two IPv6 hextets (hex strings) into a dotted-quad IPv4 string. */
function decodeEmbeddedV4(hiHex: string, loHex: string): string | null {
  const high = parseInt(hiHex, 16);
  const low = parseInt(loHex, 16);
  if (Number.isNaN(high) || Number.isNaN(low)) return null;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 10.0.0.0/8 private
  if (a === 10) return true;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 link-local (includes AWS/GCP metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 CGN (carrier-grade NAT, shared address space)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 0.0.0.0/8 unspecified / current network
  if (a === 0) return true;
  return false;
}

/**
 * Validate a URL's host is publicly routable. Throws on:
 *   - non-http(s) scheme
 *   - IP literal in private/loopback/link-local range
 *   - hostname resolving to ANY private/local address
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const u = new URL(rawUrl);

  // Reject non-http(s) schemes — gopher://, file://, dict:// etc.
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Refusing to fetch non-http(s) URL: ${u.protocol}`);
  }

  const host = u.hostname;
  // IPv6 hostnames come bracketed in URL.hostname — strip for isIP/dns.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Reject IP literals in private/loopback/link-local ranges immediately.
  if (isIP(bareHost)) {
    if (isPrivateOrLocalAddress(bareHost)) {
      throw new Error(`Refusing to fetch private/local address: ${bareHost}`);
    }
    return;
  }

  // Resolve hostname — reject if ANY resolved address is private/local.
  const addresses = await dnsLookup(bareHost, { all: true });
  if (addresses.length === 0) {
    throw new Error(`DNS resolution returned no addresses for: ${bareHost}`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrLocalAddress(address)) {
      throw new Error(
        `Refusing to fetch ${bareHost}: resolves to private/local address ${address}`,
      );
    }
  }
}

/** Maximum HTTP redirects to follow before giving up. */
const MAX_REDIRECTS = 10;

/**
 * Per-hop init callback for fetchWithRedirectGuard.
 *
 * Called for each hop with the URL about to be fetched (initial URL on hop
 * 0, redirect Location on later hops). Returns the RequestInit to use for
 * that hop. Allows callers to scope credentials per-hop — e.g. drop
 * Authorization when the target host changes.
 *
 * Receives `previousUrl` so the callback can compare host transitions
 * (initial → hop 1) without re-parsing.
 */
export type PerHopInit = (
  currentUrl: string,
  previousUrl: string | null,
) => RequestInit & { signal?: AbortSignal };

/**
 * Fetch wrapper that re-validates SSRF on every HTTP redirect (S2).
 *
 * Default `fetch()` follows redirects automatically — an attacker can register
 * `https://attacker.com` that 302's to `http://127.0.0.1/admin`, completely
 * bypassing `assertPublicUrl(originalUrl)`. This wrapper sets
 * `redirect: 'manual'` and manually walks the chain, validating each hop.
 *
 * Callers should still call `assertPublicUrl(url)` once upfront; this wrapper
 * handles ONLY the redirect chain. The reason for the split: assertPublicUrl
 * fails fast before any network I/O for the obvious cases.
 *
 * **Credential safety (S1 follow-up fix, addressed in PR#38 re-review):**
 *
 * The `init` parameter is REUSED on every hop, which means any headers in it
 * (e.g. Authorization) follow the redirect chain. This is the SAME bug as
 * default `fetch()` does — a same-host request that 302s to attacker.com
 * sends the Authorization header to the attacker.
 *
 * Two modes:
 *   1. Static `init` — backward-compatible, headers flow on every hop.
 *      Caller is responsible for either (a) only using this for URLs they
 *      control end-to-end, or (b) not including sensitive headers.
 *   2. `perHopInit` callback — caller decides per-hop what init to use,
 *      typically scoping Authorization to apiUrl host only. Recommended
 *      whenever Authorization is involved.
 *
 * If both are provided, `perHopInit` wins. If neither is provided, an
 * empty init is used.
 */
export async function fetchWithRedirectGuard(
  url: string,
  init: (RequestInit & { signal?: AbortSignal }) | PerHopInit = {},
): Promise<Response> {
  const buildInit: PerHopInit =
    typeof init === "function" ? init : () => init;

  let currentUrl = url;
  let previousUrl: string | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validate on every hop (including the first, in case of caller mistake).
    await assertPublicUrl(currentUrl);

    const hopInit = buildInit(currentUrl, previousUrl);
    const resp = await fetch(currentUrl, { ...hopInit, redirect: "manual" });

    // 3xx — follow manually after validation.
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        return resp;
      }
      const next = new URL(location, currentUrl).toString();
      previousUrl = currentUrl;
      currentUrl = next;
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      continue;
    }

    return resp;
  }
  throw new Error(`Refusing to follow more than ${MAX_REDIRECTS} redirects (started at ${url})`);
}

/**
 * Boot-time apiUrl SSRF check (S6).
 *
 * Stricter than `assertPublicUrl`: requires either `https:` to a NON-private
 * host, or `http:` to an explicit localhost form (for local development only).
 *
 * S6 fix: previously `https://` was allowed to ANY host including 127.0.0.1
 * because we only checked protocol. Now we also reject private IPs for https.
 */
export function isAllowedApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    if (parsed.protocol === "https:") {
      // Allow https to any non-private host. https://127.0.0.1 is suspicious
      // (could be a self-signed mitmproxy if NODE_TLS_REJECT_UNAUTHORIZED=0).
      if (isIP(bareHost) && isPrivateOrLocalAddress(bareHost)) return false;
      return true;
    }
    if (parsed.protocol === "http:") {
      return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    }
    return false;
  } catch {
    return false;
  }
}

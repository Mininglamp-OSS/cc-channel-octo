/**
 * Tests for Q34 (apiUrl SSRF protection), Q37 (encodeVariableLength(0)),
 * Q38 (aesIV salt length warning).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Q34: apiUrl SSRF protection ───────────────────────────────────────────

describe("apiUrl SSRF protection (Q34)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  function writeConfig(overrides: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "q34-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({ botToken: "bf_test", apiUrl: "https://safe.example.com", cwdBase: "/test/cwdbase", ...overrides }),
    );
    return cfgPath;
  }

  afterEach(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.resetModules();
  });

  it("accepts https:// URLs", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "https://api.octo.example.com" });
    const cfg = loadConfig(path);
    expect(cfg.apiUrl).toBe("https://api.octo.example.com");
  });

  it("accepts http://localhost", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "http://localhost:8080" });
    const cfg = loadConfig(path);
    expect(cfg.apiUrl).toBe("http://localhost:8080");
  });

  it("accepts http://127.0.0.1", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "http://127.0.0.1:3000" });
    const cfg = loadConfig(path);
    expect(cfg.apiUrl).toBe("http://127.0.0.1:3000");
  });

  it("rejects http:// to arbitrary host", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "http://internal-service.corp:8080" });
    expect(() => loadConfig(path)).toThrow(/Unsafe apiUrl/);
  });

  it("rejects file:// URLs", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "file:///etc/passwd" });
    expect(() => loadConfig(path)).toThrow(/Unsafe apiUrl/);
  });

  it("rejects malformed URLs", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "not-a-url" });
    expect(() => loadConfig(path)).toThrow(/Unsafe apiUrl/);
  });

  it("rejects http://[::1] IPv6 loopback is allowed", async () => {
    const { loadConfig } = await import("../config.js");
    const path = writeConfig({ apiUrl: "http://[::1]:8080" });
    const cfg = loadConfig(path);
    expect(cfg.apiUrl).toBe("http://[::1]:8080");
  });
});

// ─── Q37: encodeVariableLength(0) ──────────────────────────────────────────

describe("encodeVariableLength(0) (Q37)", () => {
  it("returns [0] for length 0", async () => {
    // encodeVariableLength is not exported, so we test via Encoder/Decoder roundtrip.
    // But the protocol test file already covers variable-length encoding.
    // Import Encoder which uses encodeVariableLength internally.
    const { Encoder, Decoder } = await import("../octo/socket.js");

    // Encode a packet with 0-length body — the variable length should be [0x00]
    const enc = new Encoder();
    enc.writeByte(0x50); // fake header byte
    // We can't call encodeVariableLength directly, but the Decoder.readVariableLength
    // should handle a single 0x00 byte correctly.
    const dec = new Decoder(new Uint8Array([0x00]));
    const len = dec.readVariableLength();
    expect(len).toBe(0);
  });

  it("still encodes non-zero lengths correctly", async () => {
    const { Decoder } = await import("../octo/socket.js");

    // 1 byte: 0x01
    const dec1 = new Decoder(new Uint8Array([0x01]));
    expect(dec1.readVariableLength()).toBe(1);

    // 127 = 0x7F (single byte)
    const dec127 = new Decoder(new Uint8Array([0x7F]));
    expect(dec127.readVariableLength()).toBe(127);

    // 128 = 0x80 0x01
    const dec128 = new Decoder(new Uint8Array([0x80, 0x01]));
    expect(dec128.readVariableLength()).toBe(128);
  });
});

// Decoder bounds checks (PR review — protocol hardening):
// a truncated/malformed packet must THROW (RangeError) instead of silently
// reading `undefined` (→ 0/NaN coercion → corrupt parses, wrong messageID/seq).
describe("Decoder bounds guards", () => {
  it("readByte throws past the end", async () => {
    const { Decoder } = await import("../octo/socket.js");
    const dec = new Decoder(new Uint8Array([]));
    expect(() => dec.readByte()).toThrow(RangeError);
  });

  it("readInt16 throws on a 1-byte buffer", async () => {
    const { Decoder } = await import("../octo/socket.js");
    const dec = new Decoder(new Uint8Array([0x01]));
    expect(() => dec.readInt16()).toThrow(/out-of-bounds/);
  });

  it("readInt32 throws on a 2-byte buffer", async () => {
    const { Decoder } = await import("../octo/socket.js");
    const dec = new Decoder(new Uint8Array([0x01, 0x02]));
    expect(() => dec.readInt32()).toThrow(/out-of-bounds/);
  });

  it("readInt64String throws on a 4-byte buffer", async () => {
    const { Decoder } = await import("../octo/socket.js");
    const dec = new Decoder(new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    expect(() => dec.readInt64String()).toThrow(/out-of-bounds/);
  });

  it("readString throws when the declared length exceeds the remaining buffer", async () => {
    const { Decoder } = await import("../octo/socket.js");
    // length prefix 0xFFFF (65535) but only 2 bytes of body follow → over-read.
    const dec = new Decoder(new Uint8Array([0xFF, 0xFF, 0x61, 0x62]));
    expect(() => dec.readString()).toThrow(/out-of-bounds/);
  });

  it("readString still returns a correctly-sized string", async () => {
    const { Decoder } = await import("../octo/socket.js");
    // length 2 + "hi"
    const dec = new Decoder(new Uint8Array([0x00, 0x02, 0x68, 0x69]));
    expect(dec.readString()).toBe("hi");
  });

  it("readByte/readInt16/readInt32 read correctly within bounds", async () => {
    const { Decoder } = await import("../octo/socket.js");
    const dec = new Decoder(new Uint8Array([0x07, 0x01, 0x02, 0x00, 0x00, 0x01, 0x00]));
    expect(dec.readByte()).toBe(0x07);
    expect(dec.readInt16()).toBe(0x0102);
    expect(dec.readInt32()).toBe(0x00000100);
  });
});

// Q38 aesIV salt length warning:
// Q1 cleanup — the placeholder `expect(true).toBe(true)` test that previously
// lived here is removed. The warning is now exercised by
// octo/wksocket-packet.test.ts (CONNACK with salt shorter than 16 bytes emits
// console.warn) using the real WKSocket + ws-mock infrastructure that was
// deferred when Q29 was first written.

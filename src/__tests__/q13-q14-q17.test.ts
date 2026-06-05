/**
 * Tests for Q13 (global rate limit), Q14 (parseIntStrict allows 0),
 * Q17 (getGroupMembers via getJson helper).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock only sendMessage so the Q13 global rate limit test doesn't make real
// fetch calls to https://test when replySafe fires (~1.7s DNS timeout per run).
// Other API functions (notably getGroupMembers used by Q17 tests below) stay
// real — their tests stub global fetch separately.
vi.mock("../octo/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../octo/api.js")>();
  return {
    ...actual,
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Q13: Global rate limit ────────────────────────────────────────────────

describe("SessionRouter global rate limit (Q13)", () => {
  // We test via the public routeAndHandle API.
  // The global limit is 10x per-session. Default maxPerMinute=5, so global=50.

  it("global rate limit blocks after burst from many sessions", async () => {
    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      cwd: ".",
      dataDir: "./data",
      sdk: { allowedTools: [], permissionMode: "bypassPermissions", settingSources: ["user"] },
      rateLimit: { maxPerMinute: 2 }, // global = 2*10 = 20
      context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524288,
    };

    const router = new SessionRouter(config, "bot_id");

    let processedCount = 0;
    const handler = async () => { processedCount++; };

    // Send 25 messages from 25 different users (each within per-session limit).
    for (let i = 0; i < 25; i++) {
      const msg = {
        message_id: `msg_${i}`,
        message_seq: i,
        from_uid: `user_${i}`,
        channel_type: ChannelType.DM,
        channel_id: `dm_${i}`,
        timestamp: Date.now(),
        payload: { type: MessageType.Text, content: "hi" },
      };
      await router.routeAndHandle(msg, handler);
    }

    // With global limit of 20, some messages should have been blocked.
    expect(processedCount).toBeLessThan(25);
    expect(processedCount).toBeGreaterThanOrEqual(20);
  });
});

// ─── Q14: parseIntStrict allows 0 ──────────────────────────────────────────

describe("parseIntStrict allows 0 (Q14)", () => {
  it("accepts 0 for maxTurns", async () => {
    // This is tested via config.test.ts 'accepts zero for maxTurns' test.
    // Additional verification here: loadConfig with env var set to 0.
    const { loadConfig } = await import("../config.js");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "q14-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ botToken: "bf_t", apiUrl: "https://a" }));

    process.env.CC_OCTO_SDK_MAX_TURNS = "0";
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.sdk.maxTurns).toBe(0);
    } finally {
      delete process.env.CC_OCTO_SDK_MAX_TURNS;
    }
  });

  it("accepts 0 for historyLimit", async () => {
    const { loadConfig } = await import("../config.js");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "q14-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ botToken: "bf_t", apiUrl: "https://a" }));

    process.env.CC_OCTO_CONTEXT_HISTORY_LIMIT = "0";
    try {
      const cfg = loadConfig(cfgPath);
      expect(cfg.context.historyLimit).toBe(0);
    } finally {
      delete process.env.CC_OCTO_CONTEXT_HISTORY_LIMIT;
    }
  });

  it("still rejects negative and non-numeric", async () => {
    const { loadConfig } = await import("../config.js");
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "q14-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ botToken: "bf_t", apiUrl: "https://a" }));

    process.env.CC_OCTO_SDK_MAX_TURNS = "-1";
    try {
      expect(() => loadConfig(cfgPath)).toThrow(/Invalid integer/);
    } finally {
      delete process.env.CC_OCTO_SDK_MAX_TURNS;
    }

    process.env.CC_OCTO_SDK_MAX_TURNS = "abc";
    try {
      expect(() => loadConfig(cfgPath)).toThrow(/Invalid integer/);
    } finally {
      delete process.env.CC_OCTO_SDK_MAX_TURNS;
    }
  });
});

// ─── Q17: getGroupMembers via getJson ──────────────────────────────────────

describe("getGroupMembers via getJson (Q17)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("includes error body in error message", async () => {
    const { getGroupMembers } = await import("../octo/api.js");

    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: () => Promise.resolve("bot not in group"),
    });

    await expect(
      getGroupMembers({ apiUrl: "https://api", botToken: "tok", groupNo: "g1" }),
    ).rejects.toThrow("bot not in group");
  });

  it("applies default timeout signal", async () => {
    const { getGroupMembers } = await import("../octo/api.js");

    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"members": []}'),
    });

    await getGroupMembers({ apiUrl: "https://api", botToken: "tok", groupNo: "g1" });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses members from response", async () => {
    const { getGroupMembers } = await import("../octo/api.js");

    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            members: [
              { uid: "u1", name: "Alice", role: 1 },
              { uid: "u2", name: "Bob", role: 0 },
            ],
          }),
        ),
    });

    const members = await getGroupMembers({
      apiUrl: "https://api",
      botToken: "tok",
      groupNo: "g1",
    });
    expect(members).toHaveLength(2);
    expect(members[0].uid).toBe("u1");
    expect(members[1].name).toBe("Bob");
  });
});

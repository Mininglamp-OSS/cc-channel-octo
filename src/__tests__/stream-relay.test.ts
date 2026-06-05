/**
 * Tests for StreamRelay — typing heartbeat, message splitting, plain sendMessage delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { splitMessage } from "../stream-relay.js";

// ─── splitMessage ───────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns single segment when text fits", () => {
    const text = "hello world";
    expect(splitMessage(text, 100)).toEqual(["hello world"]);
  });

  it("returns single segment when text equals maxChars exactly", () => {
    const text = "a".repeat(3500);
    expect(splitMessage(text)).toEqual([text]);
  });

  it("splits at paragraph boundary (\\n\\n)", () => {
    const para1 = "a".repeat(1000);
    const para2 = "b".repeat(1000);
    const para3 = "c".repeat(1000);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0]).toContain(para1);
    expect(segments.join("")).toBe(text);
  });

  it("splits at newline when no paragraph break", () => {
    const line1 = "a".repeat(2000);
    const line2 = "b".repeat(2000);
    const text = `${line1}\n${line2}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe(`${line1}\n`);
    expect(segments[1]).toBe(line2);
  });

  it("splits at space when no newline", () => {
    const word1 = "a".repeat(2000);
    const word2 = "b".repeat(2000);
    const text = `${word1} ${word2}`;
    const segments = splitMessage(text, 2500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe(`${word1} `);
    expect(segments[1]).toBe(word2);
  });

  it("hard cuts when no natural boundary", () => {
    const text = "a".repeat(7000);
    const segments = splitMessage(text, 3500);
    expect(segments.length).toBe(2);
    expect(segments[0]).toBe("a".repeat(3500));
    expect(segments[1]).toBe("a".repeat(3500));
  });

  it("handles empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("reassembles to original for multi-segment split", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} content.`).join("\n\n");
    const segments = splitMessage(text, 100);
    expect(segments.join("")).toBe(text);
  });

  it("throws on maxChars <= 0", () => {
    expect(() => splitMessage("hello", 0)).toThrow("maxChars must be >= 1");
    expect(() => splitMessage("hello", -5)).toThrow("maxChars must be >= 1");
  });

  it("works with maxChars = 1", () => {
    const segments = splitMessage("abc", 1);
    expect(segments).toEqual(["a", "b", "c"]);
  });

  it("splitMessage does not break surrogate pairs on hard cut", () => {
    // 👨‍👩‍👧‍👦 is a family emoji (ZWJ sequence, 11 UTF-16 code units)
    const emoji = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const padding = "a".repeat(10);
    const text = padding + emoji;
    // Cut at a position that would fall inside the emoji sequence
    const segments = splitMessage(text, padding.length + 2);
    // Reassembly must produce the original
    expect(segments.join("")).toBe(text);
  });

  it("splitMessage handles lone surrogate gracefully", () => {
    // A string with a high surrogate at the end (malformed but shouldn't crash)
    const text = "hello\uD83D";
    const segments = splitMessage(text, 3);
    expect(segments.join("")).toBe(text);
  });

  it("does not split surrogate pairs on hard cut", () => {
    // 😀 = U+1F600 = 😀 (2 code units)
    const emoji = "😀";
    // Fill to force a hard cut right at a surrogate pair boundary
    const filler = "a".repeat(9); // 9 + 2 = 11 code units, maxChars=10 would cut inside emoji
    const text = filler + emoji;  // 11 code units
    const segments = splitMessage(text, 10);
    // Should NOT split the surrogate pair — back up to 9
    expect(segments[0]).toBe(filler);
    expect(segments[1]).toBe(emoji);
    expect(segments.join("")).toBe(text);
  });
});

// ─── Shared mock state via vi.hoisted ───────────────────────────────────────

interface ApiCall {
  fn: string;
  args: Record<string, unknown>;
}

const mockState = vi.hoisted(() => {
  const calls: ApiCall[] = [];
  let sendMessageFail = false;
  return {
    calls,
    get sendMessageFail() { return sendMessageFail; },
    set sendMessageFail(v: boolean) { sendMessageFail = v; },
    reset() {
      calls.length = 0;
      sendMessageFail = false;
    },
  };
});

vi.mock("../octo/api.js", () => ({
  sendTyping: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "sendTyping", args: params });
  }),
  sendMessage: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "sendMessage", args: params });
    if (mockState.sendMessageFail) throw new Error("sendMessage failed");
    return { message_id: "msg_1", client_msg_no: "c1", message_seq: 1 };
  }),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

async function* asyncChunks(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

// ─── StreamRelay ────────────────────────────────────────────────────────────

// Import after mock setup so vi.mock hoisting takes effect.
const { StreamRelay } = await import("../stream-relay.js");

describe("StreamRelay", () => {
  let relay: StreamRelay;

  const CH_ID = "test_channel";
  const CH_TYPE = 2; // Group
  const API_URL = "https://api.test";
  const BOT_TOKEN = "***";

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.reset();
    relay = new StreamRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers text via sendMessage", async () => {
    const chunks = asyncChunks(["Hello, world!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0].args as { content: string }).content).toBe("Hello, world!");
  });

  it("sends typing indicator at the start", async () => {
    const chunks = asyncChunks(["Hi"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const typingCalls = mockState.calls.filter((c) => c.fn === "sendTyping");
    expect(typingCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("splits long text into segments", async () => {
    const longText = "word ".repeat(1500); // ~7500 chars
    const chunks = asyncChunks([longText]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    const reassembled = sendCalls.map((c) => (c.args as { content: string }).content).join("");
    expect(reassembled).toBe(longText);
  });

  it("handles empty stream (no output)", async () => {
    const chunks = asyncChunks([]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const nonTyping = mockState.calls.filter((c) => c.fn !== "sendTyping");
    expect(nonTyping.length).toBe(0);
  });

  it("cleans up typing timer on completion", async () => {
    const chunks = asyncChunks(["done"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("cleans up typing timer on error", async () => {
    mockState.sendMessageFail = true;

    const chunks = asyncChunks(["fail"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    // Q23: sendMessage failures are swallowed per-segment; deliver() should not reject.
    await expect(promise).resolves.toBeUndefined();

    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("accumulates multiple chunks before sending", async () => {
    const chunks = asyncChunks(["Hello", ", ", "world", "!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0].args as { content: string }).content).toBe("Hello, world!");
  });

  it("passes correct channelId and channelType to all calls", async () => {
    const chunks = asyncChunks(["test"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    for (const call of mockState.calls) {
      expect(call.args.channelId).toBe(CH_ID);
      expect(call.args.channelType).toBe(CH_TYPE);
    }
  });

  it("cleans up typing timer when source iterable throws", async () => {
    async function* throwingChunks(): AsyncIterable<string> {
      yield "partial";
      throw new Error("source exploded");
    }

    const chunks = throwingChunks();
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    await expect(promise).rejects.toThrow("source exploded");

    // No sendMessage should have been called (source threw before accumulation completed).
    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(0);

    // Typing timer should be cleaned up.
    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("passes apiUrl and botToken to sendMessage", async () => {
    const chunks = asyncChunks(["test content"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].args.apiUrl).toBe(API_URL);
    expect(sendCalls[0].args.botToken).toBe(BOT_TOKEN);
  });

  it("continues sending remaining segments when one fails", async () => {
    let callCount = 0;
    const { sendMessage } = await import("../octo/api.js");
    (sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (params: Record<string, unknown>) => {
      mockState.calls.push({ fn: "sendMessage", args: params });
      callCount++;
      if (callCount === 2) throw new Error("transient failure");
      return { message_id: "msg_1", client_msg_no: "c1", message_seq: 1 };
    });

    const longText = "word ".repeat(1500); // ~7500 chars → 3 segments
    const chunks = asyncChunks([longText]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise; // Should NOT throw

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(3); // All 3 segments attempted
  });

  // ── G7: @mention resolution in deliver() ─────────────────────────────────

  it("resolves @[uid:name] structured mentions and includes mentionUids/Entities", async () => {
    const chunks = asyncChunks(["hello @[u1:Alice] and @[u2:Bob]"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    const args = sendCalls[0].args as {
      content: string;
      mentionUids?: string[];
      mentionEntities?: Array<{ uid: string; offset: number; length: number }>;
    };
    expect(args.content).toBe("hello @Alice and @Bob");
    expect(args.mentionUids).toEqual(["u1", "u2"]);
    expect(args.mentionEntities).toHaveLength(2);
  });

  it("resolves plain @name via memberMap", async () => {
    const memberMap = new Map([["Alice", "u1"], ["Bob", "u2"]]);
    const chunks = asyncChunks(["hi @Alice and @Bob"]);
    const promise = relay.deliver(
      CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN, undefined, memberMap,
    );
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as { mentionUids?: string[] };
    expect(args.mentionUids).toEqual(["u1", "u2"]);
  });

  it("detects @all and sets mentionAll flag", async () => {
    const chunks = asyncChunks(["@all please review"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as { mentionAll?: boolean };
    expect(args.mentionAll).toBe(true);
  });

  it("omits mention fields when no mentions present", async () => {
    const chunks = asyncChunks(["just plain text"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    const args = sendCalls[0].args as Record<string, unknown>;
    expect(args.mentionUids).toBeUndefined();
    expect(args.mentionEntities).toBeUndefined();
    expect(args.mentionAll).toBeUndefined();
  });

  // ─── C2 P0-1: splitMessage must not break @[uid:name] across segments ─────
  //
  // Repro: text where the LAST space within the first maxChars chunk falls
  // INSIDE the displayName of an @[uid:John Smith Junior] mention. The space-
  // priority split would cut at "John " — leaving seg0 = "...@[uid:John " and
  // seg1 = "Smith Junior]..." — both unparseable, user sees raw text in chat
  // and never receives the @-notification.
  //
  // Fix verifies: resolve mentions globally first, THEN splitMessage on the
  // already-resolved @name text. @[uid:John Smith Junior] becomes
  // @John Smith Junior before split, so split can never cut inside `[...]`.
  it("P0-1: splitMessage cannot break structured @[uid:name] across segments", async () => {
    // Build text where without the fix, the space inside `John Smith Junior`
    // would be the LAST space within the first 3500 chars and splitMessage
    // would cut there.
    const prefix = "a".repeat(3490);
    const mention = "@[uid_x:John Smith Junior]";
    const trailing = "continuestextwithoutspacelongenoughtopastthehardlimit" + "x".repeat(150);
    const text = prefix + mention + " " + trailing;

    const chunks = asyncChunks([text]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    // No segment may contain a broken structured mention:
    for (const call of sendCalls) {
      const args = call.args as { content: string };
      expect(args.content).not.toContain("@[uid_x:");
      expect(args.content).not.toMatch(/Smith Junior\][^@]/);
    }

    // At least one segment must carry the resolved @John Smith Junior
    // + correctly mapped entity.
    const carryingCall = sendCalls.find(c => {
      const args = c.args as { content: string; mentionUids?: string[] };
      return args.content.includes("@John Smith Junior")
        && (args.mentionUids ?? []).includes("uid_x");
    });
    expect(carryingCall).toBeDefined();

    const args = carryingCall!.args as {
      content: string;
      mentionEntities?: Array<{ uid: string; offset: number; length: number }>;
    };
    const ent = (args.mentionEntities ?? []).find(e => e.uid === "uid_x");
    expect(ent).toBeDefined();
    // Entity offset is segment-local and points to the @ in this segment.
    expect(args.content.slice(ent!.offset, ent!.offset + ent!.length))
      .toBe("@John Smith Junior");
  });

  it("P0-1: mentionAll applied to first segment only (no notification spam)", async () => {
    // Force a multi-segment send with @all in the prefix. mentionAll must
    // fire on exactly one segment (the first) to avoid spamming @所有人
    // notifications when a reply is long enough to span chunks.
    const text = "@all please review:\n\n" + "x".repeat(3490) + "\n\n" + "y".repeat(500);
    const chunks = asyncChunks([text]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThan(1);
    const mentionAllFlags = sendCalls.map(
      c => (c.args as { mentionAll?: boolean }).mentionAll === true,
    );
    const trueCount = mentionAllFlags.filter(x => x).length;
    expect(trueCount).toBe(1);
    expect(mentionAllFlags[0]).toBe(true);
  });

  // ─── C2 P1-6: truncation must not split a surrogate pair ──────────────
  it("P1-6: truncation does not split surrogate pair", async () => {
    // emoji 😀 = high+low surrogate (2 code units). Position the high
    // surrogate exactly at index (N-1) so unguarded slice(0, N) would leave
    // an orphan high surrogate.
    const N = 100;
    const filler = "a".repeat(N - 1);
    const emoji = "\uD83D\uDE00";
    const text = filler + emoji + "more text afterwards";

    const chunks = asyncChunks([text]);
    const promise = relay.deliver(
      CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN, N,
    );
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThan(0);
    const combined = sendCalls
      .map(c => (c.args as { content: string }).content)
      .join("");
    // Verify no orphan high surrogate anywhere in sent content.
    for (let i = 0; i < combined.length; i++) {
      const code = combined.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = combined.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xDC00);
        expect(next).toBeLessThanOrEqual(0xDFFF);
      }
    }
  });
});

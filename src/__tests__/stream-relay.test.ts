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

    await expect(promise).rejects.toThrow("sendMessage failed");

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
});

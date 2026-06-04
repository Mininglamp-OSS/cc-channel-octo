/**
 * Tests for StreamRelay — throttled flush, stream lifecycle, fallback, splitting.
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
});

// ─── Shared mock state via vi.hoisted ───────────────────────────────────────

interface ApiCall {
  fn: string;
  args: Record<string, unknown>;
}

const mockState = vi.hoisted(() => {
  const calls: ApiCall[] = [];
  let streamStartFail = false;
  let streamSendFailAfter = -1; // Fail streamSend after N successful calls.
  let sendMessageFail = false;
  return {
    calls,
    get streamStartFail() { return streamStartFail; },
    set streamStartFail(v: boolean) { streamStartFail = v; },
    get streamSendFailAfter() { return streamSendFailAfter; },
    set streamSendFailAfter(v: number) { streamSendFailAfter = v; },
    get sendMessageFail() { return sendMessageFail; },
    set sendMessageFail(v: boolean) { sendMessageFail = v; },
    reset() {
      calls.length = 0;
      streamStartFail = false;
      streamSendFailAfter = -1;
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
  streamStart: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "streamStart", args: params });
    if (mockState.streamStartFail) throw new Error("stream API unavailable");
    return "stream_001";
  }),
  streamSend: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "streamSend", args: params });
    if (mockState.streamSendFailAfter >= 0) {
      const sendCount = mockState.calls.filter((c) => c.fn === "streamSend").length;
      if (sendCount > mockState.streamSendFailAfter) {
        throw new Error("streamSend failed");
      }
    }
  }),
  streamEnd: vi.fn(async (params: Record<string, unknown>) => {
    mockState.calls.push({ fn: "streamEnd", args: params });
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
  const BOT_TOKEN = "bf_test";

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.reset();
    relay = new StreamRelay();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers short text via stream start + end", async () => {
    const chunks = asyncChunks(["Hello, world!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const streamCalls = mockState.calls.filter((c) => c.fn.startsWith("stream"));
    expect(streamCalls.some((c) => c.fn === "streamStart")).toBe(true);
    expect(streamCalls.some((c) => c.fn === "streamEnd")).toBe(true);
  });

  it("sends typing indicator at the start", async () => {
    const chunks = asyncChunks(["Hi"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const typingCalls = mockState.calls.filter((c) => c.fn === "sendTyping");
    expect(typingCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to sendMessage when stream API fails", async () => {
    mockState.streamStartFail = true;

    const chunks = asyncChunks(["Fallback text"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBe(1);
    expect((sendCalls[0].args as { content: string }).content).toBe("Fallback text");
  });

  it("splits long fallback text into segments", async () => {
    mockState.streamStartFail = true;

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
    mockState.streamStartFail = true;
    mockState.sendMessageFail = true;

    const chunks = asyncChunks(["fail"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    // Attach a no-op catch to prevent Node's PromiseRejectionHandledWarning
    // (the rejection is still observable via the original `promise` reference).
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    // Verify the promise did reject.
    await expect(promise).rejects.toThrow("sendMessage failed");

    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });

  it("accumulates chunks between flushes", async () => {
    // Multiple chunks yielded synchronously: first chunk flushes immediately
    // (lastFlushTime=0), remaining chunks accumulate until final flush.
    const chunks = asyncChunks(["Hello", ", ", "world", "!"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    // Find the last stream payload (streamStart or streamSend) — it has the full text.
    const payloadCalls = mockState.calls.filter(
      (c) => c.fn === "streamStart" || c.fn === "streamSend",
    );
    expect(payloadCalls.length).toBeGreaterThanOrEqual(1);
    const lastPayload = (payloadCalls[payloadCalls.length - 1].args as { payload: string }).payload;
    const decoded = JSON.parse(Buffer.from(lastPayload, "base64").toString("utf-8")) as { content: string };
    // The last flush should contain all accumulated text.
    expect(decoded.content).toBe("Hello, world!");
  });

  it("passes correct channelId and channelType to stream calls", async () => {
    const chunks = asyncChunks(["test"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    for (const call of mockState.calls) {
      if (["sendTyping", "streamStart", "streamEnd", "streamSend"].includes(call.fn)) {
        expect(call.args.channelId).toBe(CH_ID);
        expect(call.args.channelType).toBe(CH_TYPE);
      }
    }
  });

  it("stream lifecycle: start → send(s) → end in order", async () => {
    const chunks = asyncChunks(["test output"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    const streamCalls = mockState.calls
      .filter((c) => c.fn.startsWith("stream"))
      .map((c) => c.fn);
    expect(streamCalls[0]).toBe("streamStart");
    expect(streamCalls[streamCalls.length - 1]).toBe("streamEnd");
  });

  it("sends accumulated text (not incremental) in each stream flush", async () => {
    const chunks = asyncChunks(["test data"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    // The streamStart payload should contain the full accumulated text
    const startCalls = mockState.calls.filter((c) => c.fn === "streamStart");
    const payload = (startCalls[0].args as { payload: string }).payload;
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as { content: string };
    expect(decoded.content).toBe("test data");
  });

  // ── Review fix: mid-stream failure calls streamEnd ─────────────────────

  it("calls streamEnd on mid-stream failure before fallback", async () => {
    // First streamSend succeeds (via streamStart), then streamSend fails on the next flush.
    mockState.streamSendFailAfter = 0; // Fail from the 1st streamSend

    // Yield two chunks: first triggers streamStart, second triggers a streamSend that fails.
    const chunks = asyncChunks(["first", " second"]);
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    await vi.runAllTimersAsync();
    await promise;

    // streamEnd should be called to close the dangling stream.
    const endCalls = mockState.calls.filter((c) => c.fn === "streamEnd");
    expect(endCalls.length).toBeGreaterThanOrEqual(1);

    // Fallback sendMessage should deliver the content.
    const sendCalls = mockState.calls.filter((c) => c.fn === "sendMessage");
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Review fix: splitMessage maxChars guard ────────────────────────────

  it("splitMessage throws on maxChars <= 0", async () => {
    expect(() => splitMessage("hello", 0)).toThrow("maxChars must be >= 1");
    expect(() => splitMessage("hello", -5)).toThrow("maxChars must be >= 1");
  });

  it("splitMessage works with maxChars = 1", () => {
    const segments = splitMessage("abc", 1);
    expect(segments).toEqual(["a", "b", "c"]);
  });

  // ── P0 fix: source iterable exception cleans up timer + stream ───────

  it("cleans up flushTimer and stream when source iterable throws", async () => {
    // Create an iterable that yields one chunk then throws.
    async function* throwingChunks(): AsyncIterable<string> {
      yield "partial";
      throw new Error("source exploded");
    }

    const chunks = throwingChunks();
    const promise = relay.deliver(CH_ID, CH_TYPE, chunks, API_URL, BOT_TOKEN);
    const guarded = promise.catch(() => {});
    await vi.runAllTimersAsync();
    await guarded;

    // Verify it rejected with the source error.
    await expect(promise).rejects.toThrow("source exploded");

    // streamEnd should have been called to close the started stream.
    const endCalls = mockState.calls.filter((c) => c.fn === "streamEnd");
    expect(endCalls.length).toBeGreaterThanOrEqual(1);

    // Typing timer should be cleaned up (no more typing calls after error).
    const countAfter = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    await vi.advanceTimersByTimeAsync(30_000);
    const countLater = mockState.calls.filter((c) => c.fn === "sendTyping").length;
    expect(countLater).toBe(countAfter);
  });
});

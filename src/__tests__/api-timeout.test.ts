/**
 * Tests for postJson default timeout behavior (Q2 fix).
 *
 * Verifies that postJson applies a 30s default timeout when no signal is provided,
 * and respects caller-provided signals when explicitly passed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { postJson } from "../octo/api.js";

// Mock the global fetch before any postJson calls.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("postJson default timeout", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("applies default timeout when no signal is provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"result": "ok"}'),
    });

    await postJson("https://api.example.com", "test-token", "/v1/bot/test", {
      key: "value",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    // After Q2 fix, postJson should always pass a signal (30s default)
    expect(options.signal).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect((options.signal as AbortSignal).aborted).toBe(false);
  });

  it("uses caller-provided signal when explicitly passed", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"result": "ok"}'),
    });

    const controller = new AbortController();
    await postJson(
      "https://api.example.com",
      "test-token",
      "/v1/bot/test",
      { key: "value" },
      controller.signal,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.signal).toBe(controller.signal);
  });

  it("rejects with abort error when timeout fires", async () => {
    const shortSignal = AbortSignal.timeout(1);

    mockFetch.mockImplementation(
      (_url: string, opts: RequestInit) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ ok: true, text: () => "" }),
            60_000,
          );
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    await expect(
      postJson(
        "https://api.example.com",
        "test-token",
        "/v1/bot/test",
        {},
        shortSignal,
      ),
    ).rejects.toThrow();
  });

  it("sends correct headers including Authorization", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    await postJson("https://api.example.com", "my-token", "/v1/bot/test", {});

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer my-token");
  });

  it("strips trailing slashes from apiUrl", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    await postJson(
      "https://api.example.com///",
      "token",
      "/v1/bot/test",
      {},
    );

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toBe("https://api.example.com/v1/bot/test");
  });

  it("throws on non-ok response with status and body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve("endpoint not found"),
    });

    await expect(
      postJson("https://api.example.com", "token", "/v1/bot/missing", {}),
    ).rejects.toThrow(
      "Octo API /v1/bot/missing failed (404): endpoint not found",
    );
  });

  it("returns undefined for empty response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(""),
    });

    const result = await postJson(
      "https://api.example.com",
      "token",
      "/v1/bot/test",
      {},
    );
    expect(result).toBeUndefined();
  });

  it("parses JSON response with int64 message_id protection", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve('{"message_id": 123456789012345678, "data": "ok"}'),
    });

    const result = await postJson<{ message_id: string; data: string }>(
      "https://api.example.com",
      "token",
      "/v1/bot/test",
      {},
    );
    expect(result).toBeDefined();
    expect(result!.message_id).toBe("123456789012345678");
    expect(result!.data).toBe("ok");
  });
});

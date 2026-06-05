/**
 * Tests for G9 (Space isolation), G10 (history segmentation), G21 (streamOn filter).
 */

import { describe, it, expect, vi } from "vitest";
import type { Config } from "../config.js";

// Shared minimal Config helper — typed instead of `as any` so refactors that
// add Config fields break loud and these tests get updated explicitly.
function makeTestConfig(): Config {
  return {
    botToken: "test",
    apiUrl: "https://test",
    cwd: "/tmp",
    dataDir: "/tmp/data",
    sdk: {
      allowedTools: [],
      permissionMode: "bypassPermissions",
      settingSources: ["user"],
    },
    rateLimit: { maxPerMinute: 100 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 524288,
  };
}

// ─── G9: Space isolation in session key ────────────────────────────────────

describe("SessionRouter Space isolation (G9)", () => {
  it("includes spaceId in DM session key when channel_id has Space format", async () => {
    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = makeTestConfig();

    const router = new SessionRouter(config, "bot_id");

    // Space DM: from_uid has format s{spaceId}_{peerId}
    const msg = {
      message_id: "1",
      message_seq: 1,
      from_uid: "sSpaceA_user123",
      channel_type: ChannelType.DM,
      channel_id: "sSpaceA_user123@sSpaceA_bot_id",
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: "hi" },
    };

    const key = router.sessionKey(msg);
    expect(key).toContain("SpaceA");
    expect(key).toContain("user123");
  });

  it("different Spaces produce different session keys", async () => {
    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = makeTestConfig();

    const router = new SessionRouter(config, "bot_id");

    const msgA = {
      message_id: "1",
      message_seq: 1,
      from_uid: "sSpaceA_user123",
      channel_type: ChannelType.DM,
      channel_id: "sSpaceA_user123@sSpaceA_bot_id",
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: "hi" },
    };

    const msgB = {
      ...msgA,
      from_uid: "sSpaceB_user123",
      channel_id: "sSpaceB_user123@sSpaceB_bot_id",
    };

    const keyA = router.sessionKey(msgA);
    const keyB = router.sessionKey(msgB);
    expect(keyA).not.toBe(keyB);
  });

  it("falls back to from_uid when no Space format", async () => {
    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = makeTestConfig();

    const router = new SessionRouter(config, "bot_id");

    const msg = {
      message_id: "1",
      message_seq: 1,
      from_uid: "plain_user_uid",
      channel_type: ChannelType.DM,
      channel_id: "plain_channel",
      timestamp: Date.now(),
      payload: { type: MessageType.Text, content: "hi" },
    };

    const key = router.sessionKey(msg);
    expect(key).toBe("plain_user_uid");
  });
});

// ─── G10: History segmentation ─────────────────────────────────────────────

describe("SessionStore history segmentation (G10)", () => {
  it("segments history into answered and new sections", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("test-session", "ch1", 2);
    store.appendUser("test-session", "first question", 1);
    store.appendAssistant("test-session", "first answer", 1);
    store.appendUser("test-session", "second question", 2);
    store.appendUser("test-session", "follow up", 3);

    // Bot last replied to message_seq 1; messages with seq > 1 are [new messages].
    store.setLastBotReplySeq("test-session", 1);

    const history = store.buildSegmentedHistoryPrefix("test-session", 40);
    expect(history).toContain("[answered history]");
    expect(history).toContain("[new messages]");
    expect(history).toContain("first answer");
    expect(history).toContain("second question");
  });

  it("returns flat history when no segmentation info", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("test-session", "ch1", 2);
    store.appendUser("test-session", "hello");

    const history = store.buildSegmentedHistoryPrefix("test-session", 40);
    expect(history).not.toContain("[answered history]");
    expect(history).not.toContain("[new messages]");
    expect(history).toContain("[user]: hello");
  });

  it("marks all as new when no assistant messages", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("test-session", "ch1", 2);
    store.appendUser("test-session", "msg1", 1);
    store.appendUser("test-session", "msg2", 2);
    store.setLastBotReplySeq("test-session", 0);

    const history = store.buildSegmentedHistoryPrefix("test-session", 40);
    expect(history).toContain("[new messages]");
    expect(history).not.toContain("[answered history]");
  });
});

// ─── G21: streamOn filter ──────────────────────────────────────────────────

describe("SessionRouter streamOn filter (G21)", () => {
  it("skips messages with streamOn=true", async () => {
    vi.resetModules();
    vi.mock("../octo/api.js", () => ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }));

    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = makeTestConfig();

    const router = new SessionRouter(config, "bot_id");
    let handlerCalled = false;

    await router.routeAndHandle(
      {
        message_id: "1",
        message_seq: 1,
        from_uid: "user1",
        channel_type: ChannelType.DM,
        channel_id: "ch1",
        timestamp: Date.now(),
        payload: { type: MessageType.Text, content: "streaming update" },
        streamOn: true,
      },
      async () => {
        handlerCalled = true;
      },
    );

    expect(handlerCalled).toBe(false);
  });

  it("processes messages with streamOn=false or undefined", async () => {
    vi.resetModules();
    vi.mock("../octo/api.js", () => ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
    }));

    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = makeTestConfig();

    const router = new SessionRouter(config, "bot_id");
    let handlerCount = 0;

    // streamOn=false
    await router.routeAndHandle(
      {
        message_id: "1",
        message_seq: 1,
        from_uid: "user1",
        channel_type: ChannelType.DM,
        channel_id: "ch1",
        timestamp: Date.now(),
        payload: { type: MessageType.Text, content: "final message" },
        streamOn: false,
      },
      async () => {
        handlerCount++;
      },
    );

    // streamOn undefined
    await router.routeAndHandle(
      {
        message_id: "2",
        message_seq: 2,
        from_uid: "user1",
        channel_type: ChannelType.DM,
        channel_id: "ch1",
        timestamp: Date.now(),
        payload: { type: MessageType.Text, content: "normal message" },
      },
      async () => {
        handlerCount++;
      },
    );

    expect(handlerCount).toBe(2);
  });
});

// ─── PR#30 review follow-ups: real segmentation by message_seq ─────────────

describe("buildSegmentedHistoryPrefix uses real message_seq (PR#30 fix)", () => {
  it("segments strictly by message_seq, not by last assistant position", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("s", "ch1", 2);
    // Seq 1 — user asked, bot replied (answered).
    store.appendUser("s", "q1", 1);
    store.appendAssistant("s", "a1", 1);
    // Seq 2, 3 — new user messages since bot's last reply.
    store.appendUser("s", "q2", 2);
    store.appendUser("s", "q3", 3);

    store.setLastBotReplySeq("s", 1);
    const out = store.buildSegmentedHistoryPrefix("s", 40);

    // Real segmentation: seq <= 1 is answered, seq > 1 is new.
    expect(out).toMatch(/\[answered history\][\s\S]*q1[\s\S]*a1[\s\S]*\[new messages\][\s\S]*q2[\s\S]*q3/);
  });

  it("omits segmentation labels when nothing new since last reply", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("s", "ch1", 2);
    store.appendUser("s", "q1", 5);
    store.appendAssistant("s", "a1", 5);
    store.setLastBotReplySeq("s", 5);

    const out = store.buildSegmentedHistoryPrefix("s", 40);
    expect(out).not.toContain("[new messages]");
    expect(out).not.toContain("[answered history]");
    expect(out).toContain("q1");
    expect(out).toContain("a1");
  });

  it("messages with NULL message_seq follow the active side", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("s", "ch1", 2);
    // Pre-G10 legacy rows: no message_seq.
    store.appendUser("s", "legacy-q");
    store.appendAssistant("s", "legacy-a");
    // New seq-aware rows.
    store.appendUser("s", "q2", 10);

    store.setLastBotReplySeq("s", 5);
    const out = store.buildSegmentedHistoryPrefix("s", 40);
    // q2 has seq=10 > 5, so it's new. Legacy rows have no seq, so they
    // attach to whichever side is active when scanned (answered side here).
    expect(out).toContain("[new messages]");
    expect(out).toContain("q2");
    expect(out).toContain("legacy-q");
  });

  it("appendUser/appendAssistant persist message_seq to the database", async () => {
    const { createAdapter } = await import("../db-adapter.js");
    const { SessionStore } = await import("../session-store.js");

    const adapter = createAdapter(":memory:");
    const store = new SessionStore(adapter);
    store.init();

    store.getOrCreate("s", "ch1", 2);
    store.appendUser("s", "hello", 42);
    store.appendAssistant("s", "hi", 42);

    const rows = adapter
      .prepare("SELECT role, content, message_seq FROM messages WHERE session_id = ? ORDER BY id")
      .all("s") as Array<{ role: string; content: string; message_seq: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].message_seq).toBe(42);
    expect(rows[1].message_seq).toBe(42);
  });
});

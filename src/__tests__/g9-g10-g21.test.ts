/**
 * Tests for G9 (Space isolation), G10 (history segmentation), G21 (streamOn filter).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── G9: Space isolation in session key ────────────────────────────────────

describe("SessionRouter Space isolation (G9)", () => {
  it("includes spaceId in DM session key when channel_id has Space format", async () => {
    const { SessionRouter } = await import("../session-router.js");
    const { ChannelType, MessageType } = await import("../octo/types.js");

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      rateLimit: { maxPerMinute: 100 },
    } as any;

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

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      rateLimit: { maxPerMinute: 100 },
    } as any;

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

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      rateLimit: { maxPerMinute: 100 },
    } as any;

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
    store.appendUser("test-session", "first question");
    store.appendAssistant("test-session", "first answer");
    store.appendUser("test-session", "second question");
    store.appendUser("test-session", "follow up");

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
    store.appendUser("test-session", "msg1");
    store.appendUser("test-session", "msg2");
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

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      rateLimit: { maxPerMinute: 100 },
    } as any;

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

    const config = {
      botToken: "test",
      apiUrl: "https://test",
      rateLimit: { maxPerMinute: 100 },
    } as any;

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

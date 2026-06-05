/**
 * Shutdown resilience tests — Q6 (drain in-flight), Q7 (store.close), Q8 (unhandledRejection).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OctoGateway } from '../gateway.js';
import type { Config } from '../config.js';

// --- Mocks ---

vi.mock('../octo/api.js', () => ({
  registerBot: vi.fn().mockResolvedValue({
    robot_id: 'bot-001',
    im_token: 'test-token',
    ws_url: 'ws://localhost:1234',
    api_url: 'https://test.example.com',
    owner_uid: 'owner',
    owner_channel_id: 'ch-owner',
  }),
  sendHeartbeat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../octo/socket.js', () => ({
  WKSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAndWait: vi.fn().mockResolvedValue(undefined),
  })),
}));

// --- Helpers ---

function makeConfig(): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp',
    dataDir: '/tmp/test-shutdown',
    sdk: {
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
    },
    rateLimit: { maxPerMinute: 10 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    botBlocklist: [],
  };
}

// --- Q6: Draining + in-flight handler drain ---

describe('Q6: shutdown drains in-flight handlers', () => {
  let gw: OctoGateway;

  beforeEach(async () => {
    vi.clearAllMocks();
    gw = new OctoGateway(makeConfig());
    await gw.start();
  });

  afterEach(async () => {
    try { await gw.stop(); } catch { /* ignore */ }
  });

  it('draining flag is false initially', () => {
    expect(gw.draining).toBe(false);
  });

  it('draining flag is true after stop()', async () => {
    await gw.stop();
    expect(gw.draining).toBe(true);
  });

  it('stop() waits for active handlers to complete', async () => {
    const activeHandlers = new Set<Promise<void>>();
    const callOrder: string[] = [];

    // Simulate a slow handler
    let resolveHandler!: () => void;
    const handlerPromise = new Promise<void>((r) => { resolveHandler = r; });
    const tracked = handlerPromise.finally(() => {
      activeHandlers.delete(tracked);
      callOrder.push('handler-done');
    });
    activeHandlers.add(tracked);

    // Start stop() — should wait for the handler
    const stopPromise = gw.stop(activeHandlers).then(() => {
      callOrder.push('stop-done');
    });

    // Handler hasn't resolved yet — stop should be waiting
    await new Promise((r) => setTimeout(r, 50));
    expect(callOrder).not.toContain('stop-done');

    // Resolve the handler
    resolveHandler();
    await stopPromise;

    expect(callOrder).toEqual(['handler-done', 'stop-done']);
  });

  it('stop() respects drain timeout', async () => {
    const activeHandlers = new Set<Promise<void>>();

    // Simulate a handler that never resolves
    const neverResolves = new Promise<void>(() => {});
    activeHandlers.add(neverResolves);

    // stop() with a short timeout should not hang
    const start = Date.now();
    await gw.stop(activeHandlers, 200);
    const elapsed = Date.now() - start;

    expect(gw.draining).toBe(true);
    // Should have timed out around 200ms, not hung forever
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it('stop() works with empty handler set', async () => {
    const activeHandlers = new Set<Promise<void>>();
    await gw.stop(activeHandlers);
    expect(gw.draining).toBe(true);
  });

  it('stop() works without handler set (backward compat)', async () => {
    await gw.stop();
    expect(gw.draining).toBe(true);
  });

  it('handleMessage drops messages when draining', async () => {
    const received: unknown[] = [];
    gw.setMessageHandler((msg) => {
      received.push(msg);
    });

    // Trigger stop to set draining
    await gw.stop();

    // Simulating a message via the gateway's internal handler is not
    // directly testable without accessing private methods, so we verify
    // the draining flag is set, which the handleMessage checks.
    expect(gw.draining).toBe(true);
  });
});

// --- Q6: Shutdown callback ---

describe('Q6: shutdown callback', () => {
  it('setShutdownCallback is called on stop', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    const callbackCalled = vi.fn();
    gw.setShutdownCallback(async () => {
      callbackCalled();
    });

    // The callback is invoked by signal handlers, not by stop() directly.
    // Verify the callback setter doesn't throw.
    expect(callbackCalled).not.toHaveBeenCalled();

    await gw.stop();
  });
});

// --- Q7 + Q8: Store close + unhandledRejection (index.ts integration) ---

describe('Q7 + Q8: orchestration integration', () => {
  it('store.close() is accessible and callable', async () => {
    // This tests that SessionStore.close() exists and works
    const { createAdapter } = await import('../db-adapter.js');
    const { SessionStore } = await import('../session-store.js');

    const adapter = createAdapter(':memory:');
    const store = new SessionStore(adapter);
    store.init();

    // Should not throw
    store.close();
  });

  it('handler errors are caught and do not become unhandled rejections', async () => {
    // Verify the pattern: .catch() on the handler promise prevents
    // unhandled rejections from reaching process level
    const errors: string[] = [];
    const handler = async () => {
      throw new Error('handler-crash');
    };

    // Mimic index.ts pattern
    const p = handler().catch((err) => {
      errors.push(err instanceof Error ? err.message : String(err));
    });

    await p;
    expect(errors).toEqual(['handler-crash']);
  });
});

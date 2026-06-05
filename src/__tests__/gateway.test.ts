/**
 * Gateway tests.
 *
 * Coverage:
 *  - Process lock: acquireLock / releaseLock / stale PID detection
 *  - Token refresh cooldown (60s window)
 *  - Heartbeat consecutive failures trigger reconnect
 *  - createSocket factory verification
 *
 * We test OctoGateway by mocking the Octo API (registerBot / sendHeartbeat)
 * and WKSocket. The lock file tests use real filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mock Octo modules before importing Gateway
vi.mock('../octo/api.js', () => ({
  registerBot: vi.fn(),
  sendHeartbeat: vi.fn(),
}));

vi.mock('../octo/socket.js', () => {
  const MockWKSocket = vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAndWait: vi.fn().mockResolvedValue(undefined),
    updateCredentials: vi.fn(),
  }));
  return { WKSocket: MockWKSocket };
});

import { OctoGateway } from '../gateway.js';
import { registerBot, sendHeartbeat } from '../octo/api.js';
import { WKSocket } from '../octo/socket.js';
import type { Config } from '../config.js';

let tmpDir: string;

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'bf_test',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/cwd',
    dataDir: tmpDir,
    sdk: {
      allowedTools: ['Read'],
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    ...overrides,
  };
}

function setupMocks() {
  vi.mocked(registerBot).mockResolvedValue({
    robot_id: 'bot-123',
    im_token: 'im-token-abc',
    ws_url: 'wss://ws.test/v1',
    api_url: 'https://api.test',
    owner_uid: 'owner-1',
    owner_channel_id: 'owner-ch',
  });
  vi.mocked(sendHeartbeat).mockResolvedValue(undefined as never);
}

// ─── 1. Process Lock ────────────────────────────────────────────────────────

describe('Process lock', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-gw-test-'));
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquireLock creates lock file with current PID', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    const lockPath = join(tmpDir, 'gateway.lock');
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));

    await gw.stop();
  });

  it('releaseLock removes lock file', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();
    await gw.stop();

    const lockPath = join(tmpDir, 'gateway.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('stale PID detection: removes lock from dead process', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    // Write a lock with a PID that definitely doesn't exist
    writeFileSync(lockPath, '999999999', { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    // Should not throw — stale lock is detected and removed
    await gw.start();

    expect(readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
    await gw.stop();
  });

  it('rejects when another live process holds the lock', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    // Write a lock with current process PID (which is alive)
    // Use PID 1 (init/launchd) which is always alive
    writeFileSync(lockPath, '1', { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    await expect(gw.start()).rejects.toThrow(/Another instance is running/);
  });
});

// ─── 2. Bot Registration + Socket Creation ──────────────────────────────────

describe('Bot registration and socket', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-gw-test-'));
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers bot and exposes robotId', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    expect(registerBot).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: 'https://test.example.com',
        botToken: 'bf_test',
      }),
    );
    expect(gw.botId).toBe('bot-123');

    await gw.stop();
  });

  it('createSocket is called with registration response', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    expect(WKSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        wsUrl: 'wss://ws.test/v1',
        uid: 'bot-123',
        token: 'im-token-abc',
      }),
    );

    await gw.stop();
  });

  it('message handler filters out self messages', async () => {
    const messages: unknown[] = [];
    const gw = new OctoGateway(makeConfig());
    gw.setMessageHandler((msg) => messages.push(msg));

    await gw.start();

    // Get the onMessage callback passed to WKSocket
    const socketCall = vi.mocked(WKSocket).mock.calls[0][0];
    const onMessage = socketCall.onMessage;

    // Message from self — should be filtered
    onMessage({ message_id: '1', message_seq: 1, from_uid: 'bot-123', timestamp: 0, payload: { type: 1 } });
    expect(messages).toHaveLength(0);

    // Message from other user — should pass through
    onMessage({ message_id: '2', message_seq: 2, from_uid: 'user-1', timestamp: 0, payload: { type: 1 } });
    expect(messages).toHaveLength(1);

    await gw.stop();
  });
});

// ─── 3. Token Refresh Cooldown ──────────────────────────────────────────────

describe('Token refresh cooldown', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-gw-test-'));
    vi.clearAllMocks();
    setupMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not refresh within 60s cooldown', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    const initialCallCount = vi.mocked(registerBot).mock.calls.length;

    // Simulate WS error that triggers refresh
    const socketOpts = vi.mocked(WKSocket).mock.calls[0][0];
    socketOpts.onError!(new Error('Kicked by server'));

    // Wait for refresh to complete
    await vi.advanceTimersByTimeAsync(100);
    const afterFirstRefresh = vi.mocked(registerBot).mock.calls.length;
    expect(afterFirstRefresh).toBe(initialCallCount + 1);

    // Try another refresh within cooldown
    socketOpts.onError!(new Error('Kicked by server'));
    await vi.advanceTimersByTimeAsync(100);

    // Should NOT have triggered another registerBot call
    expect(vi.mocked(registerBot).mock.calls.length).toBe(afterFirstRefresh);

    await gw.stop();
  });

  it('allows refresh after cooldown expires', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    const socketOpts = vi.mocked(WKSocket).mock.calls[0][0];

    // First refresh
    socketOpts.onError!(new Error('Kicked by server'));
    await vi.advanceTimersByTimeAsync(100);
    const afterFirst = vi.mocked(registerBot).mock.calls.length;

    // Advance past cooldown (60s)
    await vi.advanceTimersByTimeAsync(61_000);

    // Second refresh — should work now
    // Need to get the new socket's onError since a new WKSocket was created
    const newSocketOpts = vi.mocked(WKSocket).mock.calls[vi.mocked(WKSocket).mock.calls.length - 1][0];
    newSocketOpts.onError!(new Error('Kicked by server'));
    await vi.advanceTimersByTimeAsync(100);

    expect(vi.mocked(registerBot).mock.calls.length).toBe(afterFirst + 1);

    await gw.stop();
  });
});

// ─── 4. Heartbeat Failures ──────────────────────────────────────────────────

describe('Heartbeat consecutive failures', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-gw-test-'));
    vi.clearAllMocks();
    setupMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('triggers reconnect after 3 consecutive heartbeat failures', async () => {
    vi.mocked(sendHeartbeat).mockRejectedValue(new Error('network error'));

    const gw = new OctoGateway(makeConfig());
    await gw.start();

    const initialRegCalls = vi.mocked(registerBot).mock.calls.length;

    // Each heartbeat fires every 30s. Need 3 failures.
    await vi.advanceTimersByTimeAsync(30_000); // failure 1
    await vi.advanceTimersByTimeAsync(30_000); // failure 2
    await vi.advanceTimersByTimeAsync(30_000); // failure 3 → triggers reconnect

    // Allow async reconnect to complete
    await vi.advanceTimersByTimeAsync(100);

    // registerBot should have been called again (token refresh)
    expect(vi.mocked(registerBot).mock.calls.length).toBeGreaterThan(initialRegCalls);

    await gw.stop();
  });

  it('resets failure count on successful heartbeat', async () => {
    let failCount = 0;
    vi.mocked(sendHeartbeat).mockImplementation(async () => {
      failCount++;
      if (failCount <= 2) throw new Error('network error');
      // Third call succeeds
    });

    const gw = new OctoGateway(makeConfig());
    await gw.start();
    const initialRegCalls = vi.mocked(registerBot).mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000); // failure 1
    await vi.advanceTimersByTimeAsync(30_000); // failure 2
    await vi.advanceTimersByTimeAsync(30_000); // success — resets counter

    // Should NOT have triggered reconnect
    expect(vi.mocked(registerBot).mock.calls.length).toBe(initialRegCalls);

    await gw.stop();
  });
});

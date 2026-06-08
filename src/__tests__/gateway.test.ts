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
    // Lock format is "<pid> <nonce>" — the first field is our PID.
    const [pidField] = readFileSync(lockPath, 'utf-8').trim().split(/\s+/);
    expect(pidField).toBe(String(process.pid));

    await gw.stop();
  });

  it('releaseLock removes lock file', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();
    await gw.stop();

    const lockPath = join(tmpDir, 'gateway.lock');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('handles lock file with non-numeric content', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    writeFileSync(lockPath, 'not-a-pid\n', { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    // Non-numeric PID should be treated as stale (kill would fail) and overwritten
    await gw.start();
    const [pidField] = readFileSync(lockPath, 'utf-8').trim().split(/\s+/);
    expect(pidField).toBe(String(process.pid));
    await gw.stop();
  });

  it('stale PID detection: removes lock from dead process', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    // Write a lock with a PID that definitely doesn't exist
    writeFileSync(lockPath, '999999999', { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    // Should not throw — stale lock is detected and removed
    await gw.start();

    const [pidField] = readFileSync(lockPath, 'utf-8').trim().split(/\s+/);
    expect(pidField).toBe(String(process.pid));
    await gw.stop();
  });

  it('rejects when another live, signalable process holds the lock', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    // Use OUR OWN pid: it is alive AND signalable by us (process.kill(pid,0) ok),
    // so acquireLock must treat it as a live holder and refuse. (PID 1 would be
    // EPERM on a non-root runner, which we now correctly reclaim as a reused PID.)
    writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    await expect(gw.start()).rejects.toThrow(/Another instance is running/);
  });

  it('reclaims a lock whose PID exists but is not signalable (EPERM → reused PID)', async () => {
    const lockPath = join(tmpDir, 'gateway.lock');
    // PID 1 (init/launchd) is alive but owned by root — process.kill(1,0) throws
    // EPERM for a normal user. Since our bot runs as one service user with its
    // own dataDir, an unsignalable PID can't be our instance → reclaim as stale.
    writeFileSync(lockPath, '1', { mode: 0o600 });

    const gw = new OctoGateway(makeConfig());
    // On a root CI runner kill(1,0) succeeds → would reject; skip that case.
    if (process.getuid && process.getuid() === 0) {
      await expect(gw.start()).rejects.toThrow(/Another instance is running/);
    } else {
      await gw.start();
      const [pidField] = readFileSync(lockPath, 'utf-8').trim().split(/\s+/);
      expect(pidField).toBe(String(process.pid));
      await gw.stop();
    }
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

  it('passes botToken and apiUrl to registerBot', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();

    expect(registerBot).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: 'https://test.example.com',
        botToken: 'bf_test',
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

  it('does not overlap heartbeats when one is slow to settle', async () => {
    // A heartbeat that takes longer than the 30s interval must NOT pile up: the
    // overlap guard skips ticks while one is in flight (no concurrent requests,
    // no failCount race).
    let resolveFirst!: () => void;
    let calls = 0;
    vi.mocked(sendHeartbeat).mockImplementation(() => {
      calls++;
      // Only the first call hangs; if the guard fails, a 2nd call would start.
      return new Promise<void>((res) => { resolveFirst = res; });
    });

    const gw = new OctoGateway(makeConfig());
    await gw.start();

    await vi.advanceTimersByTimeAsync(30_000); // tick 1 → request starts, hangs
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); // tick 2 → skipped (in flight)
    await vi.advanceTimersByTimeAsync(30_000); // tick 3 → skipped (in flight)
    expect(calls).toBe(1); // still only ONE in-flight request, no pile-up

    resolveFirst(); // let it settle
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(30_000); // next tick can now issue
    expect(calls).toBe(2);

    await gw.stop();
  });

  it('webhook mode token refresh re-registers WITHOUT opening a socket', async () => {
    vi.mocked(sendHeartbeat).mockRejectedValue(new Error('network error'));

    // Webhook mode: register() + startServices() (heartbeat + signals), no WS.
    const gw = new OctoGateway(makeConfig(), { handleSignals: false });
    await gw.register();
    gw.startServices();
    expect(vi.mocked(WKSocket)).not.toHaveBeenCalled();
    const initialRegCalls = vi.mocked(registerBot).mock.calls.length;

    // 3 heartbeat failures → token refresh.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(100);

    // Token WAS refreshed (re-registered)...
    expect(vi.mocked(registerBot).mock.calls.length).toBeGreaterThan(initialRegCalls);
    // ...but NO socket was ever opened — webhook mode must not create a WS.
    expect(vi.mocked(WKSocket)).not.toHaveBeenCalled();

    await gw.stop();
  });
});

describe('Two-phase startup: register() then connect()', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-gw-2p-'));
    vi.clearAllMocks();
    setupMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('register() populates botId WITHOUT opening the socket', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.register();
    expect(gw.botId).toBe('bot-123');
    expect(gw.ownerUid).toBe('owner-1');
    // No socket constructed yet — the WS only opens in connect().
    expect(vi.mocked(WKSocket)).not.toHaveBeenCalled();
    await gw.stop();
  });

  it('a message handler can be installed between register() and connect()', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.register();
    // Wiring the handler before connect() is the whole point — no throw, no socket.
    expect(() => gw.setMessageHandler(() => {})).not.toThrow();
    expect(vi.mocked(WKSocket)).not.toHaveBeenCalled();
    gw.connect();
    expect(vi.mocked(WKSocket)).toHaveBeenCalledTimes(1);
    await gw.stop();
  });

  it('connect() before register() throws (lifecycle guard)', () => {
    const gw = new OctoGateway(makeConfig());
    expect(() => gw.connect()).toThrow(/before register/i);
  });

  it('start() still does register + connect in one call (back-compat)', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.start();
    expect(gw.botId).toBe('bot-123');
    expect(vi.mocked(WKSocket)).toHaveBeenCalledTimes(1);
    await gw.stop();
  });

  it('startServices() runs heartbeat + shutdown WITHOUT opening a socket (webhook mode)', async () => {
    const gw = new OctoGateway(makeConfig());
    await gw.register();
    gw.startServices();
    // No WebSocket created — webhook mode opens no socket.
    expect(vi.mocked(WKSocket)).not.toHaveBeenCalled();
    await gw.stop();
  });

  it('startServices() before register() throws', () => {
    const gw = new OctoGateway(makeConfig());
    expect(() => gw.startServices()).toThrow(/before register/i);
  });
});

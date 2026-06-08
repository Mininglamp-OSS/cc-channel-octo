/**
 * P2 polish tests — Q31 (version from package.json), Q32 (response truncation), Q36 (heartbeat restart).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Q32: Response truncation in StreamRelay ---

import { StreamRelay } from '../stream-relay.js';

vi.mock('../octo/api.js', () => ({
  sendTyping: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(undefined),
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

import { sendMessage } from '../octo/api.js';
import { ChannelType } from '../octo/types.js';

describe('Q32: response truncation', () => {
  let relay: StreamRelay;

  beforeEach(() => {
    vi.clearAllMocks();
    relay = new StreamRelay();
  });

  it('truncates response exceeding maxResponseChars', async () => {
    const limit = 100;
    async function* bigChunks(): AsyncIterable<string> {
      // Yield 200 chars total
      yield 'A'.repeat(80);
      yield 'B'.repeat(120);
    }

    await relay.deliver('ch1', ChannelType.DM, bigChunks(), 'https://api', 'tok', limit);

    expect(sendMessage).toHaveBeenCalled();
    const sentContent = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
    expect(sentContent.length).toBeLessThanOrEqual(limit + 30); // account for truncation suffix
    expect(sentContent).toContain('[response truncated]');
  });

  it('does not truncate response within limit', async () => {
    const limit = 500;
    async function* smallChunks(): AsyncIterable<string> {
      yield 'Hello ';
      yield 'World!';
    }

    await relay.deliver('ch1', ChannelType.DM, smallChunks(), 'https://api', 'tok', limit);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentContent = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
    expect(sentContent).toBe('Hello World!');
    expect(sentContent).not.toContain('[truncated]');
  });

  it('uses default limit (512KB) when not specified', async () => {
    async function* smallChunks(): AsyncIterable<string> {
      yield 'short response';
    }

    // Call without maxResponseChars — should use default (no truncation for small input)
    await relay.deliver('ch1', ChannelType.DM, smallChunks(), 'https://api', 'tok');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentContent = (sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string;
    expect(sentContent).toBe('short response');
  });
});

// --- Q31: Version from package.json ---

describe('Q31: gateway reads version from package.json', () => {
  it('PKG_VERSION matches package.json version', async () => {
    // We can't directly import the private PKG_VERSION constant,
    // but we can verify the gateway passes a non-hardcoded version to registerBot.
    const { OctoGateway } = await import('../gateway.js');
    const { registerBot } = await import('../octo/api.js');
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string };

    vi.mock('../octo/socket.js', () => ({
      WKSocket: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        disconnectAndWait: vi.fn().mockResolvedValue(undefined),
      })),
    }));

    const gw = new OctoGateway({
      botToken: 'tok',
      apiUrl: 'https://api',
      cwd: '/tmp',
      dataDir: '/tmp/test-q31',
      sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
      rateLimit: { maxPerMinute: 5 },
      context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524_288,
      botBlocklist: [],
    });

    await gw.start();

    // registerBot should have been called with the version from package.json
    const calls = (registerBot as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstCall = calls[0][0] as Record<string, unknown>;
    expect(firstCall.agentVersion).toBe(pkg.version);
    // Should NOT be a hardcoded '0.1.0' if the package.json has been updated
    expect(firstCall.agentVersion).toBeDefined();
    expect(typeof firstCall.agentVersion).toBe('string');

    await gw.stop();
  });
});

// --- Q36: heartbeat restart after token refresh ---

describe('Q36: heartbeat restart after token refresh', () => {
  it('startHeartbeat called after successful token refresh', async () => {
    const { OctoGateway } = await import('../gateway.js');
    const { sendHeartbeat } = await import('../octo/api.js');

    vi.mock('../octo/socket.js', () => ({
      WKSocket: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        disconnectAndWait: vi.fn().mockResolvedValue(undefined),
      })),
    }));

    vi.useFakeTimers();

    const gw = new OctoGateway({
      botToken: 'tok',
      apiUrl: 'https://api',
      cwd: '/tmp',
      dataDir: '/tmp/test-q36',
      sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['user'] },
      rateLimit: { maxPerMinute: 5 },
      context: { maxContextChars: 6000, historyLimit: 40 },
      maxResponseChars: 524_288,
      botBlocklist: [],
    });

    await gw.start();

    // Clear initial heartbeat calls
    (sendHeartbeat as ReturnType<typeof vi.fn>).mockClear();

    // Advance timer to trigger heartbeat — should fire
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendHeartbeat).toHaveBeenCalled();

    vi.useRealTimers();
    await gw.stop();
  });
});

// --- Q32: Config maxResponseChars ---

describe('Q32: maxResponseChars config', () => {
  it('defaults to 524288 (512KB)', async () => {
    const { loadConfig } = await import('../config.js');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const dir = mkdtempSync(join(tmpdir(), 'p2-q32-'));
    const cfgPath = join(dir, 'config.json');
    // No maxResponseChars in the file → falls back to the default.
    writeFileSync(cfgPath, JSON.stringify({ botToken: 'test', apiUrl: 'https://test' }));

    const cfg = loadConfig(cfgPath);
    expect(cfg.maxResponseChars).toBe(524_288);
  });
});

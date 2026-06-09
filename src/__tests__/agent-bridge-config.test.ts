/**
 * Agent Bridge config-forwarding tests (P2 nit-2).
 *
 * Covers two SDK option behaviors that previously had no test:
 *  - Q1: `anthropicBaseUrl` is forwarded via the scoped `options.env`
 *        (spread over process.env) so it reaches the SDK subprocess without
 *        mutating the gateway's own global env. When unset, `options.env` is
 *        omitted entirely.
 *  - Q2: `allowedTools: "*"` is the "no whitelist" sentinel — the option is
 *        omitted entirely so the SDK falls back to its built-in tool set. An
 *        explicit string[] is forwarded as-is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { queryAgent } from '../agent-bridge.js';
import type { Config } from '../config.js';

const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

function makeConfig(sdkOverrides: Partial<Config['sdk']> = {}): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/test',
    dataDir: '/tmp/data',
    sdk: {
      allowedTools: '*',
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
      ...sdkOverrides,
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 1000,
  };
}

function createMockStream() {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'result', subtype: 'success' };
    },
    close: vi.fn(),
  };
}

async function drain(config: Config): Promise<void> {
  for await (const chunk of queryAgent('hello', config)) {
    void chunk;
    // Drain generator so queryAgent invokes the SDK mock.
  }
}

describe('queryAgent SDK configuration forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_BASE_URL;
    mockQuery.mockReturnValue(createMockStream());
  });

  afterEach(() => {
    if (originalAnthropicBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
    }
  });

  it('forwards ANTHROPIC_BASE_URL via scoped options.env, not global process.env', async () => {
    await drain(makeConfig({ anthropicBaseUrl: 'https://gw.example.com' }));

    const options = mockQuery.mock.calls[0][0].options;
    // Scoped to the subprocess env, spread over process.env to preserve PATH etc.
    expect(options.env).toBeDefined();
    expect(options.env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    expect(options.env.PATH).toBe(process.env.PATH);
    // The gateway's own global env must NOT be mutated (no cross-request leak).
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('does not set options.env or mutate process.env when not configured', async () => {
    await drain(makeConfig());

    const options = mockQuery.mock.calls[0][0].options;
    expect(options.env).toBeUndefined();
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('omits allowedTools when configured as wildcard', async () => {
    await drain(makeConfig({ allowedTools: '*' }));

    const options = mockQuery.mock.calls[0][0].options;
    expect(options).not.toHaveProperty('allowedTools');
  });

  it('forwards allowedTools arrays to the SDK', async () => {
    await drain(makeConfig({ allowedTools: ['Read'] }));

    const options = mockQuery.mock.calls[0][0].options;
    expect(options.allowedTools).toEqual(['Read']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Claude Agent SDK
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { queryAgent } from '../agent-bridge.js';
import type { Config } from '../config.js';

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    botToken: 'test-token',
    apiUrl: 'https://test.example.com',
    cwd: '/tmp/test',
    dataDir: '/tmp/data',
    sdk: {
      allowedTools: ['Read', 'Grep'],
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    ...overrides,
  };
}

function createMockStream(messages: Array<{ type: string; [key: string]: unknown }>) {
  let closed = false;
  const stream = {
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        if (closed) return;
        yield msg;
      }
    },
    close: vi.fn(() => { closed = true; }),
  };
  return stream;
}

describe('queryAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields text blocks from assistant messages', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('Hi', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(stream.close).toHaveBeenCalled();
  });

  it('skips non-text blocks (e.g. tool_use)', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool1', name: 'Read', input: {} },
            { type: 'text', text: 'Result here' },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Result here']);
  });

  it('skips non-assistant message types', async () => {
    const stream = createMockStream([
      { type: 'system', text: 'System init' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Only this' }] },
      },
      { type: 'tool', content: 'tool output' },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Only this']);
  });

  it('yields error message on non-success result', async () => {
    const stream = createMockStream([
      { type: 'result', subtype: 'error' },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['\n[Error: error]']);
  });

  it('does not yield error for success result', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      { type: 'result', subtype: 'success' },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['done']);
  });

  it('calls stream.close() in finally (even on error)', async () => {
    const stream = createMockStream([]);
    // Make the iterator throw
    stream[Symbol.asyncIterator] = async function* () {
      throw new Error('SDK crashed');
    };
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    try {
      for await (const chunk of queryAgent('test', '', '', makeConfig())) {
        chunks.push(chunk);
      }
    } catch {
      // expected
    }
    expect(stream.close).toHaveBeenCalled();
  });

  it('passes correct SDK options', async () => {
    const stream = createMockStream([]);
    mockQuery.mockReturnValue(stream);

    const config = makeConfig({
      cwd: '/my/project',
      sdk: {
        allowedTools: ['Read', 'Write'],
        permissionMode: 'bypassPermissions',
        settingSources: ['user', 'project'],
        model: 'claude-sonnet-4-20250514',
        maxTurns: 5,
        systemPrompt: 'Custom instructions',
      },
    });

    // Consume the generator
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of queryAgent('hello', '[user]: prev', 'group ctx', config)) { /* drain */ }

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello',
        options: expect.objectContaining({
          cwd: '/my/project',
          allowedTools: ['Read', 'Write'],
          permissionMode: 'bypassPermissions',
          model: 'claude-sonnet-4-20250514',
          maxTurns: 5,
          settingSources: ['user', 'project'],
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
    // systemPrompt is the claude_code preset (required for SDK auto-memory to
    // activate); our composed text rides in `append`.
    const callArgs = mockQuery.mock.calls[0][0];
    const sp = callArgs.options.systemPrompt;
    expect(sp).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(sp.append).toContain('untrusted IM users');
    expect(sp.append).toContain('Custom instructions');
    expect(sp.append).toContain('[Group context]');
    expect(sp.append).toContain('[Conversation history]');
  });

  it('throws on invalid permissionMode', async () => {
    const config = makeConfig({ sdk: { allowedTools: [], permissionMode: 'invalid', settingSources: ['user'] } });
    const stream = createMockStream([]);
    mockQuery.mockReturnValue(stream);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of queryAgent('test', '', '', config)) { /* drain */ }
    }).rejects.toThrow('Invalid permissionMode');
  });

  it('throws on invalid settingSource', async () => {
    const config = makeConfig({ sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['invalid'] } });
    const stream = createMockStream([]);
    mockQuery.mockReturnValue(stream);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of queryAgent('test', '', '', config)) { /* drain */ }
    }).rejects.toThrow('Invalid settingSource');
  });

  it('skips text blocks with empty text', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'actual content' },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['actual content']);
  });

  // --- v0.3 tool progress: onToolUse callback ---

  it('fires onToolUse for each tool_use block, in order', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const tools: string[] = [];
    const chunks: string[] = [];
    for await (const chunk of queryAgent('test', '', '', makeConfig(), undefined, (t) => tools.push(t))) {
      chunks.push(chunk);
    }
    expect(tools).toEqual(['Bash', 'Read']);
    expect(chunks).toEqual(['thinking']);
  });

  it('uses a fallback name when a tool_use block has no name', async () => {
    const stream = createMockStream([
      { type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } },
    ]);
    mockQuery.mockReturnValue(stream);

    const tools: string[] = [];
    for await (const _ of queryAgent('t', '', '', makeConfig(), undefined, (t) => tools.push(t))) {
      void _;
    }
    expect(tools).toEqual(['tool']);
  });

  it('a throwing onToolUse callback never breaks the stream', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'still here' },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    const onToolUse = (): void => {
      throw new Error('callback boom');
    };
    for await (const chunk of queryAgent('t', '', '', makeConfig(), undefined, onToolUse)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['still here']);
  });

  it('does not require onToolUse (tool_use blocks are simply ignored)', async () => {
    const stream = createMockStream([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: 'ok' },
          ],
        },
      },
    ]);
    mockQuery.mockReturnValue(stream);

    const chunks: string[] = [];
    for await (const chunk of queryAgent('t', '', '', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['ok']);
  });

  // --- v0.3 persistent sessions: resume + onSessionId ---

  it('forwards opts.resume as the SDK resume option', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig(), undefined, undefined, { resume: 'prior-sid' })) {
      void _;
    }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.resume).toBe('prior-sid');
  });

  it('omits resume when not provided', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('resume');
  });

  it('enables SDK auto-memory at opts.memoryDir via inline settings', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig(), undefined, undefined, { memoryDir: '/mem/abc' })) {
      void _;
    }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.settings).toEqual({ autoMemoryEnabled: true, autoMemoryDirectory: '/mem/abc' });
    // settingSources is orthogonal and left intact.
    expect(options.settingSources).toEqual(['user']);
  });

  it('omits settings when no memoryDir is provided', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('settings');
  });

  // --- #94: external octo-cli integration (env injection + system-prompt guide) ---

  it('injects OCTO_API_BASE_URL + OCTO_BOT_ID into env when octoCli is on', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      apiUrl: 'https://octo.example.com/api',
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], octoCli: true },
    });
    for await (const _ of queryAgent('t', '', '', config, undefined, undefined, { botRobotId: 'cli_x' })) { void _; }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.env.OCTO_API_BASE_URL).toBe('https://octo.example.com/api');
    expect(options.env.OCTO_BOT_ID).toBe('cli_x');
    // process.env is preserved (SDK env REPLACES the subprocess env).
    expect(options.env.PATH).toBe(process.env.PATH);
  });

  it('omits OCTO_BOT_ID when octoCli is on but no robot id is available', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({ sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], octoCli: true } });
    for await (const _ of queryAgent('t', '', '', config)) { void _; }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.env.OCTO_API_BASE_URL).toBe('https://test.example.com');
    expect(options.env).not.toHaveProperty('OCTO_BOT_ID');
  });

  it('sets no OCTO_* env (and may omit env entirely) when octoCli is off', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig(), undefined, undefined, { botRobotId: 'cli_x' })) { void _; }
    const options = mockQuery.mock.calls[0][0].options;
    // No anthropicBaseUrl and octoCli off → env omitted entirely.
    expect(options).not.toHaveProperty('env');
  });

  it('coexists with anthropicBaseUrl (all three vars present)', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      apiUrl: 'https://octo.example.com/api',
      sdk: {
        allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [],
        octoCli: true, anthropicBaseUrl: 'https://llm.example.com',
      },
    });
    for await (const _ of queryAgent('t', '', '', config, undefined, undefined, { botRobotId: 'cli_x' })) { void _; }
    const env = mockQuery.mock.calls[0][0].options.env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://llm.example.com');
    expect(env.OCTO_API_BASE_URL).toBe('https://octo.example.com/api');
    expect(env.OCTO_BOT_ID).toBe('cli_x');
  });

  it('appends the octo-cli guide to the system prompt only when octoCli is on', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const on = makeConfig({ sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], octoCli: true } });
    for await (const _ of queryAgent('t', '', '', on)) { void _; }
    expect(mockQuery.mock.calls[0][0].options.systemPrompt.append).toContain('[Octo CLI');

    mockQuery.mockClear();
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', '', '', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options.systemPrompt.append).not.toContain('[Octo CLI');
  });

  it('reports the SDK session_id once via onSessionId', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 'sid-xyz', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', session_id: 'sid-xyz', message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'result', subtype: 'success', session_id: 'sid-xyz' },
    ]));
    const ids: string[] = [];
    for await (const _ of queryAgent('t', '', '', makeConfig(), undefined, undefined, { onSessionId: (id) => ids.push(id) })) {
      void _;
    }
    expect(ids).toEqual(['sid-xyz']); // reported exactly once
  });

  it('a throwing onSessionId callback never breaks the stream', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'still streamed' }] } },
    ]));
    const chunks: string[] = [];
    const onSessionId = (): void => { throw new Error('boom'); };
    for await (const chunk of queryAgent('t', '', '', makeConfig(), undefined, undefined, { onSessionId })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['still streamed']);
  });
});

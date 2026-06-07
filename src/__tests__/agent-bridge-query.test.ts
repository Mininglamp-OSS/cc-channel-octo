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
    // systemPrompt should contain security prefix + custom + group ctx + history
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toContain('untrusted IM users');
    expect(callArgs.options.systemPrompt).toContain('Custom instructions');
    expect(callArgs.options.systemPrompt).toContain('[Group context]');
    expect(callArgs.options.systemPrompt).toContain('[Conversation history]');
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
});

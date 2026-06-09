import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Claude Agent SDK
const mockQuery = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

// Mock the skill linker (#100) so we can assert invocation without touching fs.
vi.mock('../skill-linker.js', () => ({ linkSkillsIntoSandbox: vi.fn() }));

// Mock cwd-resolver so resolveSessionCwd is deterministic + fs-free.
vi.mock('../cwd-resolver.js', () => ({
  resolveSessionCwd: (cwdBase: string, ctx: { kind: string; sessionKey: string }) =>
    `${cwdBase}/${ctx.kind}-${ctx.sessionKey}`,
}));

import { queryAgent } from '../agent-bridge.js';
import { linkSkillsIntoSandbox } from '../skill-linker.js';
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
    for await (const chunk of queryAgent('Hi', makeConfig())) {
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
    for await (const chunk of queryAgent('test', makeConfig())) {
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
    for await (const chunk of queryAgent('test', makeConfig())) {
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
    for await (const chunk of queryAgent('test', makeConfig())) {
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
    for await (const chunk of queryAgent('test', makeConfig())) {
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
      for await (const chunk of queryAgent('test', makeConfig())) {
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
    for await (const _ of queryAgent('hello', config)) { /* drain */ }

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
    // activate); our FROZEN composed text rides in `append`.
    const callArgs = mockQuery.mock.calls[0][0];
    const sp = callArgs.options.systemPrompt;
    expect(sp).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(sp.append).toContain('untrusted IM users');
    expect(sp.append).toContain('Custom instructions');
    // FROZEN: history (B5) and group context (B4) are NOT in the system prompt —
    // they ride in the user message / SDK session now.
    expect(sp.append).not.toContain('\n[Group context]\n');
    expect(sp.append).not.toContain('\n[Conversation history]\n');
  });

  it('throws on invalid permissionMode', async () => {
    const config = makeConfig({ sdk: { allowedTools: [], permissionMode: 'invalid', settingSources: ['user'] } });
    const stream = createMockStream([]);
    mockQuery.mockReturnValue(stream);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of queryAgent('test', config)) { /* drain */ }
    }).rejects.toThrow('Invalid permissionMode');
  });

  it('throws on invalid settingSource', async () => {
    const config = makeConfig({ sdk: { allowedTools: [], permissionMode: 'bypassPermissions', settingSources: ['invalid'] } });
    const stream = createMockStream([]);
    mockQuery.mockReturnValue(stream);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of queryAgent('test', config)) { /* drain */ }
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
    for await (const chunk of queryAgent('test', makeConfig())) {
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
    for await (const chunk of queryAgent('test', makeConfig(), undefined, (t) => tools.push(t))) {
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
    for await (const _ of queryAgent('t', makeConfig(), undefined, (t) => tools.push(t))) {
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
    for await (const chunk of queryAgent('t', makeConfig(), undefined, onToolUse)) {
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
    for await (const chunk of queryAgent('t', makeConfig())) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['ok']);
  });

  // --- v0.3 persistent sessions: resume + onSessionId ---

  it('forwards opts.resume as the SDK resume option', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', makeConfig(), undefined, undefined, { resume: 'prior-sid' })) {
      void _;
    }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.resume).toBe('prior-sid');
  });

  it('omits resume when not provided', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('resume');
  });

  it('enables SDK auto-memory at opts.memoryDir via inline settings', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', makeConfig(), undefined, undefined, { memoryDir: '/mem/abc' })) {
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
    for await (const _ of queryAgent('t', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('settings');
  });

  // --- #100: generic skill loading (project-scope + symlink) ---

  it('symlinks skill dirs into the sandbox when settingSources includes project', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      cwdBase: '/tmp/cwdbase',
      skillsDir: '/base/default/skills',
      globalSkillsDir: '/base/skills',
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'] },
    });
    for await (const _ of queryAgent('t', config, { kind: 'dm', sessionKey: 'u1' })) { void _; }
    expect(linkSkillsIntoSandbox).toHaveBeenCalledTimes(1);
    const [sandboxDir, sources] = vi.mocked(linkSkillsIntoSandbox).mock.calls[0];
    // sandbox is the resolved per-session cwd under cwdBase
    expect(sandboxDir.startsWith('/tmp/cwdbase/')).toBe(true);
    // global first, per-bot second (later wins on name collision)
    expect(sources).toEqual(['/base/skills', '/base/default/skills']);
  });

  it('does NOT symlink skills when settingSources excludes project', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      skillsDir: '/base/default/skills',
      globalSkillsDir: '/base/skills',
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [] },
    });
    for await (const _ of queryAgent('t', config, { kind: 'dm', sessionKey: 'u1' })) { void _; }
    expect(linkSkillsIntoSandbox).not.toHaveBeenCalled();
  });

  it('does NOT symlink skills when no sessionCtx (no sandbox)', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      skillsDir: '/base/default/skills',
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'] },
    });
    for await (const _ of queryAgent('t', config)) { void _; }
    expect(linkSkillsIntoSandbox).not.toHaveBeenCalled();
  });

  it('skips linking when project is set but no skill dirs are configured', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({
      cwdBase: '/tmp/cwdbase',
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'] },
    });
    for await (const _ of queryAgent('t', config, { kind: 'dm', sessionKey: 'u1' })) { void _; }
    expect(linkSkillsIntoSandbox).not.toHaveBeenCalled();
  });

  it('forwards settingSources verbatim to the SDK', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's-1', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const config = makeConfig({ sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'] } });
    for await (const _ of queryAgent('t', config)) { void _; }
    expect(mockQuery.mock.calls[0][0].options.settingSources).toEqual(['project']);
  });

  it('reports the SDK session_id once via onSessionId', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 'sid-xyz', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', session_id: 'sid-xyz', message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'result', subtype: 'success', session_id: 'sid-xyz' },
    ]));
    const ids: string[] = [];
    for await (const _ of queryAgent('t', makeConfig(), undefined, undefined, { onSessionId: (id) => ids.push(id) })) {
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
    for await (const chunk of queryAgent('t', makeConfig(), undefined, undefined, { onSessionId })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['still streamed']);
  });

  // --- stale/expired resume recovery (Phase 5; spike-verified the SDK throws
  // "No conversation found with session ID: …") ---

  it('recovers from a stale resume: clears the id and retries WITHOUT resume', async () => {
    // First call (with resume) throws the SDK's stale-session error before any
    // output; second call (no resume) succeeds.
    const throwing = createMockStream([]);
    throwing[Symbol.asyncIterator] = async function* () {
      throw new Error('No conversation found with session ID: stale-sid');
    };
    const ok = createMockStream([
      { type: 'assistant', session_id: 'fresh-sid', message: { content: [{ type: 'text', text: 'recovered' }] } },
    ]);
    mockQuery.mockReturnValueOnce(throwing).mockReturnValueOnce(ok);

    let resumeFailed = false;
    const ids: string[] = [];
    const chunks: string[] = [];
    for await (const chunk of queryAgent('hi', makeConfig(), undefined, undefined, {
      resume: 'stale-sid',
      onSessionId: (id) => ids.push(id),
      onResumeFailed: () => { resumeFailed = true; },
      fallbackHistoryBlock: '[Prior conversation history]\nold turn\n---\n',
    })) {
      chunks.push(chunk);
    }

    expect(resumeFailed).toBe(true);
    expect(chunks).toEqual(['recovered']);
    // The retry was made WITHOUT resume and WITH the fallback history prepended.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0].options.resume).toBe('stale-sid');
    expect(mockQuery.mock.calls[1][0].options).not.toHaveProperty('resume');
    expect(mockQuery.mock.calls[1][0].prompt).toBe('[Prior conversation history]\nold turn\n---\nhi');
    // The fresh session id is still captured for next turn.
    expect(ids).toEqual(['fresh-sid']);
  });

  it('caps the stale-resume retry prompt so a huge fallback history cannot blow the budget (PR #120 review #3)', async () => {
    const throwing = createMockStream([]);
    throwing[Symbol.asyncIterator] = async function* () {
      throw new Error('No conversation found with session ID: stale');
    };
    const ok = createMockStream([
      { type: 'assistant', session_id: 'fresh', message: { content: [{ type: 'text', text: 'ok' }] } },
    ]);
    mockQuery.mockReturnValueOnce(throwing).mockReturnValueOnce(ok);

    const hugeFallback = '[Prior conversation history]\n' + 'x'.repeat(300_000) + '\n---\n';
    for await (const _ of queryAgent('THE REQUEST', makeConfig(), undefined, undefined, {
      resume: 'stale', onSessionId: () => {}, onResumeFailed: () => {},
      fallbackHistoryBlock: hugeFallback,
    })) { void _; }

    const retryPrompt = mockQuery.mock.calls[1][0].prompt as string;
    // The current request survives WHOLE at the end; the fallback was front-truncated.
    expect(retryPrompt.endsWith('THE REQUEST')).toBe(true);
    expect(retryPrompt).toContain('[… earlier context truncated]');
    // Retry prompt stays within the 96 KB payload budget (+ small marker slack).
    expect(Buffer.byteLength(retryPrompt, 'utf-8')).toBeLessThanOrEqual(98_304 + 64);
  });

  it('does NOT recover (rethrows) when the error is unrelated to resume', async () => {
    const throwing = createMockStream([]);
    throwing[Symbol.asyncIterator] = async function* () {
      throw new Error('some other SDK failure');
    };
    mockQuery.mockReturnValue(throwing);
    let resumeFailed = false;
    await expect(async () => {
      for await (const _ of queryAgent('hi', makeConfig(), undefined, undefined, {
        resume: 'sid', onResumeFailed: () => { resumeFailed = true; },
      })) { void _; }
    }).rejects.toThrow('some other SDK failure');
    expect(resumeFailed).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no retry
  });

  it('does NOT retry if the stale error arrives AFTER output (no double reply)', async () => {
    // Emit a chunk, THEN throw a resume-shaped error: recovery must not fire
    // (we already streamed a partial reply; a retry would duplicate it).
    const partial = createMockStream([]);
    partial[Symbol.asyncIterator] = async function* () {
      yield { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'partial' }] } };
      throw new Error('No conversation found with session ID: x');
    };
    mockQuery.mockReturnValue(partial);
    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of queryAgent('hi', makeConfig(), undefined, undefined, {
        resume: 'sid', onResumeFailed: () => {},
      })) { chunks.push(chunk); }
    }).rejects.toThrow('No conversation found');
    expect(chunks).toEqual(['partial']);
    expect(mockQuery).toHaveBeenCalledTimes(1); // no retry after partial output
  });
});

describe('queryAgent — sdk.env injection (#107)', () => {
  beforeEach(() => vi.clearAllMocks());

  function drain(config: Config): Promise<void> {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    return (async () => {
      for await (const _ of queryAgent('t', config)) { void _; }
    })();
  }

  it('injects sdk.env into the subprocess env (preserving process.env)', async () => {
    const config = makeConfig({
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], env: { OCTO_BOT_ID: 'cli_x' } },
    });
    await drain(config);
    const env = mockQuery.mock.calls[0][0].options.env;
    expect(env.OCTO_BOT_ID).toBe('cli_x');
    expect(env.PATH).toBe(process.env.PATH); // process.env preserved
  });

  it('merges sdk.env with anthropicBaseUrl (both present)', async () => {
    const config = makeConfig({
      sdk: {
        allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [],
        env: { OCTO_BOT_ID: 'cli_x', FOO: 'bar' }, anthropicBaseUrl: 'https://llm.example.com',
      },
    });
    await drain(config);
    const env = mockQuery.mock.calls[0][0].options.env;
    expect(env.OCTO_BOT_ID).toBe('cli_x');
    expect(env.FOO).toBe('bar');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://llm.example.com');
  });

  it('omits env entirely when neither sdk.env nor anthropicBaseUrl is set', async () => {
    await drain(makeConfig());
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('env');
  });

  it('omits env when sdk.env is an empty object', async () => {
    const config = makeConfig({
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: [], env: {} },
    });
    await drain(config);
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('env');
  });
});

describe('queryAgent — sdk.skills selection (#110)', () => {
  beforeEach(() => vi.clearAllMocks());

  function drainSkills(config: Config): Promise<void> {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    return (async () => {
      for await (const _ of queryAgent('t', config)) { void _; }
    })();
  }

  it('forwards sdk.skills array to the SDK when set', async () => {
    const config = makeConfig({
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'], skills: ['octo-messaging', 'github-issue-triage'] },
    });
    await drainSkills(config);
    expect(mockQuery.mock.calls[0][0].options.skills).toEqual(['octo-messaging', 'github-issue-triage']);
  });

  it("forwards sdk.skills 'all'", async () => {
    const config = makeConfig({
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'], skills: 'all' },
    });
    await drainSkills(config);
    expect(mockQuery.mock.calls[0][0].options.skills).toBe('all');
  });

  it('omits skills when unset (SDK default)', async () => {
    await drainSkills(makeConfig());
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('skills');
  });

  it('forwards an empty array verbatim (explicit "no skills")', async () => {
    const config = makeConfig({
      sdk: { allowedTools: '*', permissionMode: 'bypassPermissions', settingSources: ['project'], skills: [] },
    });
    await drainSkills(config);
    expect(mockQuery.mock.calls[0][0].options.skills).toEqual([]);
  });
});

describe('queryAgent — mcpServers forwarding (#115)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards opts.mcpServers to the SDK options when provided', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    const fakeServer = { type: 'sdk', name: 'cron', instance: {} } as never;
    for await (const _ of queryAgent('t', makeConfig(), undefined, undefined, { mcpServers: { cron: fakeServer } })) { void _; }
    const options = mockQuery.mock.calls[0][0].options;
    expect(options.mcpServers).toBeDefined();
    expect(options.mcpServers.cron).toBe(fakeServer);
  });

  it('omits mcpServers when not provided', async () => {
    mockQuery.mockReturnValue(createMockStream([
      { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]));
    for await (const _ of queryAgent('t', makeConfig())) { void _; }
    expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty('mcpServers');
  });
});

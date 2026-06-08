/**
 * #94: octo-cli profile auto-seeding tests.
 *
 * Mocks node:child_process `spawn` to assert the security invariant — the token
 * goes via stdin, NEVER argv — and that the helper is best-effort (ENOENT and
 * non-zero exit both resolve without throwing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { seedOctoCliProfile } from '../octo-cli.js';

/** A fake ChildProcess: EventEmitter + stdin/stderr stubs. */
function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn> };
    stderr: EventEmitter;
  };
  child.stdin = { end: vi.fn() };
  child.stderr = new EventEmitter();
  return child;
}

describe('seedOctoCliProfile (#94)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs the bot in with --bot-id + --with-token; token via stdin, NOT argv', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = seedOctoCliProfile({
      apiUrl: 'https://octo.example.com/api',
      botToken: 'bf_supersecret',
      robotId: 'cli_abc',
    });
    // Simulate a successful login.
    child.emit('close', 0);
    await p;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0];
    expect(bin).toBe('octo-cli');
    expect(args).toEqual([
      'auth', 'login', '--bot-id', 'cli_abc', '--with-token', '--api-base-url', 'https://octo.example.com/api',
    ]);
    // SECURITY: the token must never appear in argv.
    expect(args).not.toContain('bf_supersecret');
    expect(JSON.stringify(args)).not.toContain('bf_supersecret');
    // The token is written to stdin (with a trailing newline) and stdin closed.
    expect(child.stdin.end).toHaveBeenCalledWith('bf_supersecret\n');
    // OCTO_API_BASE_URL exported to the child.
    expect(opts.env.OCTO_API_BASE_URL).toBe('https://octo.example.com/api');
  });

  it('resolves (no throw) when the binary is missing (ENOENT)', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = seedOctoCliProfile({ apiUrl: 'https://a', botToken: 'bf_t', robotId: 'cli_x' });
    const err = new Error('spawn octo-cli ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    child.emit('error', err);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves (no throw) on a non-zero exit', async () => {
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = seedOctoCliProfile({ apiUrl: 'https://a', botToken: 'bf_t', robotId: 'cli_x' });
    child.stderr.emit('data', Buffer.from('{"ok":false,"error":{"message":"nope"}}'));
    child.emit('close', 3);
    await expect(p).resolves.toBeUndefined();
  });

  it('skips spawning entirely when no robot id is given', async () => {
    await expect(
      seedOctoCliProfile({ apiUrl: 'https://a', botToken: 'bf_t', robotId: '' }),
    ).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never logs the raw token, even on failure', async () => {
    const warn = vi.spyOn(console, 'warn');
    const child = makeChild();
    spawnMock.mockReturnValue(child);

    const p = seedOctoCliProfile({ apiUrl: 'https://a', botToken: 'bf_LEAKME', robotId: 'cli_x' });
    child.stderr.emit('data', Buffer.from('some error'));
    child.emit('close', 1);
    await p;

    const allWarnText = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allWarnText).not.toContain('bf_LEAKME');
  });
});

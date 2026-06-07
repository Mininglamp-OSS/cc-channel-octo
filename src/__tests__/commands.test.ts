/**
 * Slash command tests (v0.3): /reset, /config, /help, unknown, and the
 * "not a command" passthrough.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCommand, handleCommand } from '../commands.js';
import { SessionStore } from '../session-store.js';
import { createAdapter, type DbAdapter } from '../db-adapter.js';
import type { Config } from '../config.js';

function makeConfig(overrides?: Partial<Config['sdk']>): Config {
  return {
    botToken: 'bf_test',
    apiUrl: 'https://octo.example.com',
    cwdBase: '/tmp/base',
    cwd: '/tmp/base',
    dataDir: '/tmp/data',
    sdk: {
      allowedTools: '*',
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
      ...overrides,
    },
    rateLimit: { maxPerMinute: 5 },
    context: { maxContextChars: 6000, historyLimit: 40 },
    maxResponseChars: 1000,
  };
}

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/reset')).toEqual({ name: 'reset', args: '' });
  });

  it('lowercases the command name and trims args', () => {
    expect(parseCommand('/Config   verbose ')).toEqual({ name: 'config', args: 'verbose' });
  });

  it('only considers the first line', () => {
    expect(parseCommand('/reset\nplease')).toEqual({ name: 'reset', args: '' });
  });

  it('tolerates leading/trailing whitespace on the line', () => {
    expect(parseCommand('   /help  ')).toEqual({ name: 'help', args: '' });
  });

  it('returns null when slash is not leading', () => {
    expect(parseCommand('please /reset')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(parseCommand('hello there')).toBeNull();
  });

  it('returns null for a lone slash', () => {
    expect(parseCommand('/')).toBeNull();
  });

  it('captures hyphenated/underscored command names', () => {
    expect(parseCommand('/foo-bar_baz x')).toEqual({ name: 'foo-bar_baz', args: 'x' });
  });
});

describe('handleCommand', () => {
  let adapter: DbAdapter;
  let store: SessionStore;
  const config = makeConfig();
  const KEY = 'user-001';

  beforeEach(() => {
    adapter = createAdapter(':memory:');
    store = new SessionStore(adapter);
    store.init();
  });

  afterEach(() => {
    store.close();
  });

  it('passes through non-command text (handled=false)', () => {
    const r = handleCommand('what is the weather', KEY, store, config);
    expect(r.handled).toBe(false);
    expect(r.reply).toBeUndefined();
  });

  it('/reset clears the session history and confirms', () => {
    store.getOrCreate(KEY, 'ch', 1);
    store.appendUser(KEY, 'first message', 1);
    store.appendAssistant(KEY, 'a reply', 1);
    expect(store.buildHistoryPrefix(KEY, 40)).not.toBe('');

    const r = handleCommand('/reset', KEY, store, config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/cleared/i);
    expect(store.buildHistoryPrefix(KEY, 40)).toBe('');
  });

  it('/reset is scoped to the calling sessionKey only', () => {
    store.getOrCreate('group:alice', 'ch', 2);
    store.appendUser('group:alice', 'alice msg', 1);
    store.getOrCreate('group:bob', 'ch', 2);
    store.appendUser('group:bob', 'bob msg', 1);

    handleCommand('/reset', 'group:alice', store, config);

    expect(store.buildHistoryPrefix('group:alice', 40)).toBe('');
    // Bob's history is untouched.
    expect(store.buildHistoryPrefix('group:bob', 40)).toContain('bob msg');
  });

  it('/config shows non-sensitive settings without leaking secrets', () => {
    const r = handleCommand('/config', KEY, store, makeConfig({ allowedTools: ['Read', 'Grep'] }));
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('allowedTools: Read, Grep');
    expect(r.reply).toContain('permissionMode: bypassPermissions');
    // Never echo the bot token.
    expect(r.reply).not.toContain('bf_test');
  });

  it('/config renders the wildcard toolset readably', () => {
    const r = handleCommand('/config', KEY, store, config);
    expect(r.reply).toContain('* (all SDK tools)');
  });

  it('/help lists the commands', () => {
    const r = handleCommand('/help', KEY, store, config);
    expect(r.handled).toBe(true);
    expect(r.reply).toContain('/reset');
    expect(r.reply).toContain('/config');
  });

  it('unknown command is reported (handled=true) instead of reaching the agent', () => {
    const r = handleCommand('/frobnicate', KEY, store, config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/unknown command/i);
    expect(r.reply).toContain('/frobnicate');
  });

  it('a path-like message that does not lead with a known slash word is still parsed as a command token', () => {
    // Documents current behavior: "/etc" leads with a slash, so it is treated
    // as an (unknown) command rather than forwarded. Acceptable — real prompts
    // rarely start with a bare "/etc"; users can prefix with text if needed.
    const r = handleCommand('/etc/passwd please read', KEY, store, config);
    expect(r.handled).toBe(true);
    expect(r.reply).toMatch(/unknown command/i);
  });
});

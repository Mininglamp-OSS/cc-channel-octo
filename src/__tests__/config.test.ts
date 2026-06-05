/**
 * Config tests.
 *
 * Coverage:
 *  - loadConfig three-level priority (env > file > defaults)
 *  - parseCsv / parseIntStrict boundary cases
 *  - Required field validation (botToken / apiUrl)
 *  - Invalid JSON error message includes file path
 *  - _-prefix key filtering
 *  - Full CC_OCTO_* env override coverage
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};
const CC_VARS = [
  'CC_OCTO_BOT_TOKEN', 'CC_OCTO_API_URL', 'CC_OCTO_CWD', 'CC_OCTO_DATA_DIR',
  'CC_OCTO_SDK_MODEL', 'CC_OCTO_SDK_ALLOWED_TOOLS', 'CC_OCTO_SDK_PERMISSION_MODE',
  'CC_OCTO_SDK_MAX_TURNS', 'CC_OCTO_SDK_SYSTEM_PROMPT', 'CC_OCTO_SDK_SETTING_SOURCES',
  'CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE', 'CC_OCTO_CONTEXT_MAX_CHARS',
  'CC_OCTO_CONTEXT_HISTORY_LIMIT', 'CC_OCTO_BOT_BLOCKLIST',
];

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'cc-octo-config-test-'));
  for (const v of CC_VARS) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
}

function teardown() {
  for (const v of CC_VARS) {
    if (savedEnv[v] !== undefined) {
      process.env[v] = savedEnv[v];
    } else {
      delete process.env[v];
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}

function writeConfig(obj: Record<string, unknown>, filename = 'config.json'): string {
  const path = join(tmpDir, filename);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

// ─── 1. Defaults ────────────────────────────────────────────────────────────

describe('loadConfig defaults', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns correct defaults when only required fields are provided via file', () => {
    const path = writeConfig({ botToken: 'bf_test', apiUrl: 'https://api.test' });
    const cfg = loadConfig(path);

    expect(cfg.botToken).toBe('bf_test');
    expect(cfg.apiUrl).toBe('https://api.test');
    expect(cfg.cwd).toBe(process.cwd());
    expect(cfg.dataDir).toBe('./data');
    expect(cfg.sdk.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    expect(cfg.sdk.permissionMode).toBe('bypassPermissions');
    expect(cfg.sdk.settingSources).toEqual(['user']);
    expect(cfg.rateLimit.maxPerMinute).toBe(5);
    expect(cfg.context.maxContextChars).toBe(6000);
    expect(cfg.context.historyLimit).toBe(40);
    expect(cfg.botBlocklist).toBeUndefined();
  });
});

// ─── 2. Three-Level Priority ────────────────────────────────────────────────

describe('three-level priority: env > file > defaults', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('file overrides defaults', () => {
    const path = writeConfig({
      botToken: 'bf_file',
      apiUrl: 'https://file.test',
      dataDir: '/custom/data',
      rateLimit: { maxPerMinute: 10 },
    });
    const cfg = loadConfig(path);
    expect(cfg.dataDir).toBe('/custom/data');
    expect(cfg.rateLimit.maxPerMinute).toBe(10);
  });

  it('env overrides file', () => {
    const path = writeConfig({
      botToken: 'bf_file',
      apiUrl: 'https://file.test',
      dataDir: '/from-file',
    });
    process.env.CC_OCTO_DATA_DIR = '/from-env';
    const cfg = loadConfig(path);
    expect(cfg.dataDir).toBe('/from-env');
  });

  it('env overrides defaults when no config file', () => {
    process.env.CC_OCTO_BOT_TOKEN = 'bf_env';
    process.env.CC_OCTO_API_URL = 'https://env.test';
    process.env.CC_OCTO_DATA_DIR = '/env-data';
    const cfg = loadConfig(join(tmpDir, 'nonexistent.json'));
    expect(cfg.botToken).toBe('bf_env');
    expect(cfg.apiUrl).toBe('https://env.test');
    expect(cfg.dataDir).toBe('/env-data');
  });
});

// ─── 3. Required Fields ────────────────────────────────────────────────────

describe('required field validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('throws when botToken is missing', () => {
    const path = writeConfig({ apiUrl: 'https://api.test' });
    expect(() => loadConfig(path)).toThrow(/botToken/);
  });

  it('throws when apiUrl is missing', () => {
    const path = writeConfig({ botToken: 'bf_test' });
    expect(() => loadConfig(path)).toThrow(/apiUrl/);
  });

  it('throws when both are missing', () => {
    const path = writeConfig({});
    expect(() => loadConfig(path)).toThrow(/botToken/);
  });
});

// ─── 4. Invalid JSON ───────────────────────────────────────────────────────

describe('invalid config file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('throws with file path in error message', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{invalid json!!!');
    expect(() => loadConfig(path)).toThrow(new RegExp(`Failed to parse config file ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

// ─── 5. Underscore-Prefix Key Filtering ─────────────────────────────────────

describe('_-prefix key filtering', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('strips keys starting with _ (e.g. _comment)', () => {
    const path = writeConfig({
      _comment: 'This is a comment',
      _version: '1.0',
      botToken: 'bf_test',
      apiUrl: 'https://api.test',
    });
    const cfg = loadConfig(path);
    expect(cfg.botToken).toBe('bf_test');
    // _comment should not appear anywhere in the config
    expect((cfg as unknown as Record<string, unknown>)['_comment']).toBeUndefined();
  });
});

// ─── 6. Env Override Full Coverage ──────────────────────────────────────────

describe('CC_OCTO_* env override coverage', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('CC_OCTO_BOT_TOKEN + CC_OCTO_API_URL', () => {
    process.env.CC_OCTO_BOT_TOKEN = 'bf_env_tok';
    process.env.CC_OCTO_API_URL = 'https://env-api';
    const cfg = loadConfig(join(tmpDir, 'nope.json'));
    expect(cfg.botToken).toBe('bf_env_tok');
    expect(cfg.apiUrl).toBe('https://env-api');
  });

  it('CC_OCTO_CWD', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CWD = '/env-cwd';
    expect(loadConfig(path).cwd).toBe('/env-cwd');
  });

  it('CC_OCTO_SDK_MODEL', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MODEL = 'claude-opus-4-0-20250514';
    expect(loadConfig(path).sdk.model).toBe('claude-opus-4-0-20250514');
  });

  it('CC_OCTO_SDK_ALLOWED_TOOLS (csv)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = 'Read, Grep, Glob';
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('CC_OCTO_SDK_PERMISSION_MODE', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_PERMISSION_MODE = 'acceptEdits';
    expect(loadConfig(path).sdk.permissionMode).toBe('acceptEdits');
  });

  it('CC_OCTO_SDK_MAX_TURNS', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '10';
    expect(loadConfig(path).sdk.maxTurns).toBe(10);
  });

  it('CC_OCTO_SDK_SYSTEM_PROMPT', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_SYSTEM_PROMPT = 'You are a helpful bot';
    expect(loadConfig(path).sdk.systemPrompt).toBe('You are a helpful bot');
  });

  it('CC_OCTO_SDK_SETTING_SOURCES (csv)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_SETTING_SOURCES = 'user, project';
    expect(loadConfig(path).sdk.settingSources).toEqual(['user', 'project']);
  });

  it('CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE = '20';
    expect(loadConfig(path).rateLimit.maxPerMinute).toBe(20);
  });

  it('CC_OCTO_CONTEXT_MAX_CHARS', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CONTEXT_MAX_CHARS = '3000';
    expect(loadConfig(path).context.maxContextChars).toBe(3000);
  });

  it('CC_OCTO_CONTEXT_HISTORY_LIMIT', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CONTEXT_HISTORY_LIMIT = '20';
    expect(loadConfig(path).context.historyLimit).toBe(20);
  });

  it('CC_OCTO_BOT_BLOCKLIST (csv)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_BOT_BLOCKLIST = 'bot-a, bot-b, bot-c';
    expect(loadConfig(path).botBlocklist).toEqual(['bot-a', 'bot-b', 'bot-c']);
  });
});

// ─── 7. parseIntStrict Boundary Cases ───────────────────────────────────────

describe('parseIntStrict via env', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('rejects hex string (0xff)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '0xff';
    expect(() => loadConfig(path)).toThrow(/Invalid integer/);
  });

  it('rejects negative number', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '-5';
    expect(() => loadConfig(path)).toThrow(/Invalid integer/);
  });

  it('accepts zero for maxTurns', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '0';
    expect(loadConfig(path).sdk.maxTurns).toBe(0);
  });

  it('rejects scientific notation', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '1e3';
    expect(() => loadConfig(path)).toThrow(/Invalid integer/);
  });

  it('rejects float', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '3.14';
    expect(() => loadConfig(path)).toThrow(/Invalid integer/);
  });

  it('rejects empty string (env var set but empty)', () => {
    // Empty string env vars are falsy, so CC_OCTO_SDK_MAX_TURNS="" won't trigger parseIntStrict.
    // But let's verify the behavior: empty string should not override.
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '';
    const cfg = loadConfig(path);
    expect(cfg.sdk.maxTurns).toBeUndefined(); // empty string = falsy = no override
  });

  it('rejects non-numeric string', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = 'abc';
    expect(() => loadConfig(path)).toThrow(/Invalid integer/);
  });

  it('accepts valid positive integer', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_MAX_TURNS = '42';
    expect(loadConfig(path).sdk.maxTurns).toBe(42);
  });
});

// ─── 8. parseCsv Edge Cases ─────────────────────────────────────────────────

describe('parseCsv via env', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('trims whitespace around items', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = '  Read ,  Grep  , Glob  ';
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('filters empty segments from trailing commas', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = 'Read,,Grep,,,';
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('single item without commas', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = 'Read';
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read']);
  });
});

// ─── 9. Config File Missing ─────────────────────────────────────────────────

describe('missing config file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('falls back to defaults + env when config file does not exist', () => {
    process.env.CC_OCTO_BOT_TOKEN = 'bf_env';
    process.env.CC_OCTO_API_URL = 'https://env-api';
    const cfg = loadConfig(join(tmpDir, 'missing.json'));
    expect(cfg.botToken).toBe('bf_env');
    expect(cfg.sdk.permissionMode).toBe('bypassPermissions'); // default
  });
});

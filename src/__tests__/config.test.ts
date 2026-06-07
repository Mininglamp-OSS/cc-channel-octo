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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig, resolveBotConfigs } from '../config.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};
const CC_VARS = [
  'CC_OCTO_BOT_TOKEN', 'CC_OCTO_API_URL', 'CC_OCTO_CWD', 'CC_OCTO_CWDBASE',
  'CC_OCTO_DATA_DIR',
  'CC_OCTO_SDK_MODEL', 'CC_OCTO_SDK_ALLOWED_TOOLS', 'CC_OCTO_SDK_PERMISSION_MODE',
  'CC_OCTO_SDK_MAX_TURNS', 'CC_OCTO_SDK_SYSTEM_PROMPT', 'CC_OCTO_SDK_SETTING_SOURCES',
  'CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE', 'CC_OCTO_CONTEXT_MAX_CHARS',
  'CC_OCTO_CONTEXT_HISTORY_LIMIT', 'CC_OCTO_BOT_BLOCKLIST',
  'CC_OCTO_MENTION_FREE_GROUPS', 'CC_OCTO_MAX_RESPONSE_CHARS',
  'ANTHROPIC_BASE_URL', 'CC_OCTO_SDK_TOOL_PROGRESS', 'CC_OCTO_SDK_PERSISTENT_SESSION',
  'CC_OCTO_GROUP_CONFIG_DIR',
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
    expect(cfg.cwdBase).toBe(process.cwd()); // Q3: cwdBase replaces cwd
    expect(cfg.dataDir).toBe('./data');
    // Q2: default is the wildcard sentinel — no whitelist applied at the SDK layer.
    expect(cfg.sdk.allowedTools).toBe('*');
    expect(cfg.sdk.permissionMode).toBe('bypassPermissions');
    expect(cfg.sdk.settingSources).toEqual(['user']);
    expect(cfg.sdk.anthropicBaseUrl).toBeUndefined(); // Q1: unset by default
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

  it('CC_OCTO_CWDBASE', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CWDBASE = '/env-cwdbase';
    expect(loadConfig(path).cwdBase).toBe('/env-cwdbase');
  });

  it('CC_OCTO_CWD (legacy alias) still applies with a deprecation warning', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CWD = '/env-cwd-legacy';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig(path);
    expect(cfg.cwdBase).toBe('/env-cwd-legacy');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CC_OCTO_CWD is deprecated'));
    warnSpy.mockRestore();
  });

  it('CC_OCTO_CWDBASE wins when both CC_OCTO_CWDBASE and CC_OCTO_CWD are set', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_CWDBASE = '/env-cwdbase-wins';
    process.env.CC_OCTO_CWD = '/env-cwd-loses';
    expect(loadConfig(path).cwdBase).toBe('/env-cwdbase-wins');
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

  it('CC_OCTO_MENTION_FREE_GROUPS (csv) overrides config (G12)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_MENTION_FREE_GROUPS = 'group-1, group-2,group-3';
    expect(loadConfig(path).mentionFreeGroups).toEqual(['group-1', 'group-2', 'group-3']);
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

// ─── Q12: Config file permission warning ───────────────────────────────

describe('Config file permission warning (Q12)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cfg-perm-'));
    // Minimal env to pass required field validation
    process.env.CC_OCTO_BOT_TOKEN = 'test-token';
    process.env.CC_OCTO_API_URL = 'https://test-api';
  });

  afterEach(() => {
    delete process.env.CC_OCTO_BOT_TOKEN;
    delete process.env.CC_OCTO_API_URL;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('warns when config file is world-readable (0o644)', () => {
    const cfgPath = join(tmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ botToken: 'tok', apiUrl: 'https://api' }));
    chmodSync(cfgPath, 0o644);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig(cfgPath);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('chmod 600'),
    );
    warnSpy.mockRestore();
  });

  it('does NOT warn when config file is owner-only (0o600)', () => {
    const cfgPath = join(tmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ botToken: 'tok', apiUrl: 'https://api' }), { mode: 0o600 });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfig(cfgPath);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── Q1: anthropicBaseUrl ──────────────────────────────────────────────

describe('Q1: anthropicBaseUrl', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('reads sdk.anthropicBaseUrl from config file', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { anthropicBaseUrl: 'https://gw.example.com' },
    });
    expect(loadConfig(path).sdk.anthropicBaseUrl).toBe('https://gw.example.com');
  });

  it('ANTHROPIC_BASE_URL env overrides config file', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { anthropicBaseUrl: 'https://from-file' },
    });
    process.env.ANTHROPIC_BASE_URL = 'https://from-env';
    expect(loadConfig(path).sdk.anthropicBaseUrl).toBe('https://from-env');
  });

  it('uses Anthropic SDK standard variable name (no CC_OCTO_ prefix)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    // A CC_OCTO_ANTHROPIC_BASE_URL would NOT take effect — only the bare var.
    process.env.ANTHROPIC_BASE_URL = 'https://standard';
    expect(loadConfig(path).sdk.anthropicBaseUrl).toBe('https://standard');
  });

  it('rejects an http:// (non-localhost) anthropicBaseUrl (SSRF protection)', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { anthropicBaseUrl: 'http://evil.example.com' },
    });
    expect(() => loadConfig(path)).toThrow(/Unsafe sdk\.anthropicBaseUrl/);
  });

  it('rejects an anthropicBaseUrl resolving to a private IP literal', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { anthropicBaseUrl: 'https://169.254.169.254' },
    });
    expect(() => loadConfig(path)).toThrow(/Unsafe sdk\.anthropicBaseUrl/);
  });

  it('allows http://localhost for local development', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { anthropicBaseUrl: 'http://localhost:8080' },
    });
    expect(loadConfig(path).sdk.anthropicBaseUrl).toBe('http://localhost:8080');
  });
});

// ─── Q2: allowedTools "*" | string[] ───────────────────────────────────

describe('Q2: allowedTools wildcard', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('config file can set allowedTools to "*"', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { allowedTools: '*' },
    });
    expect(loadConfig(path).sdk.allowedTools).toBe('*');
  });

  it('config file can set allowedTools to an explicit array', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { allowedTools: ['Read', 'Glob', 'Grep'] },
    });
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('CC_OCTO_SDK_ALLOWED_TOOLS="*" maps to the wildcard sentinel', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = '*';
    expect(loadConfig(path).sdk.allowedTools).toBe('*');
  });

  it('CC_OCTO_SDK_ALLOWED_TOOLS=" * " (whitespace) still maps to wildcard', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = ' * ';
    expect(loadConfig(path).sdk.allowedTools).toBe('*');
  });

  it('CC_OCTO_SDK_ALLOWED_TOOLS with a "*" element anywhere maps to wildcard', () => {
    // Regression: a CSV containing `*` must collapse to the wildcard sentinel
    // rather than passing a literal `*` through as a (bogus) tool name.
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = '*,Read';
    expect(loadConfig(path).sdk.allowedTools).toBe('*');
  });

  it('CC_OCTO_SDK_ALLOWED_TOOLS without "*" stays a CSV array', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = 'Read, Glob ,Grep';
    expect(loadConfig(path).sdk.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('env "*" overrides a config-file array', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { allowedTools: ['Read'] },
    });
    process.env.CC_OCTO_SDK_ALLOWED_TOOLS = '*';
    expect(loadConfig(path).sdk.allowedTools).toBe('*');
  });
});

// ─── Q3: cwdBase / cwd alias ───────────────────────────────────────────

describe('Q3: cwdBase + deprecated cwd alias', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('config.cwdBase is honored directly', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      cwdBase: '/explicit/base',
    });
    expect(loadConfig(path).cwdBase).toBe('/explicit/base');
  });

  it('legacy config.cwd still maps to cwdBase with a deprecation warning', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      cwd: '/legacy/dir',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig(path);
    expect(cfg.cwdBase).toBe('/legacy/dir');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('config.cwd is deprecated'));
    warnSpy.mockRestore();
  });

  it('config.cwdBase wins over config.cwd when both are present', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      cwdBase: '/wins',
      cwd: '/loses',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfig(path);
    expect(cfg.cwdBase).toBe('/wins');
    // cwdBase is defined → cwd alias must NOT trigger its deprecation warning.
    const cwdWarnings = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === 'string' && c[0].includes('config.cwd is deprecated'),
    );
    expect(cwdWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('blank config.cwdBase falls back to the default (not "")', () => {
    // A `"cwdBase": ""` typo must not slip past the nullish fallback and land
    // sandboxes relative to process.cwd().
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      cwdBase: '   ',
    });
    expect(loadConfig(path).cwdBase).toBe(process.cwd());
  });

  it('blank CC_OCTO_CWDBASE env is ignored (treated as unset)', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      cwdBase: '/explicit/base',
    });
    process.env.CC_OCTO_CWDBASE = '  ';
    expect(loadConfig(path).cwdBase).toBe('/explicit/base');
  });
});

// ─── v0.3: sdk.toolProgress ────────────────────────────────────────────

describe('v0.3: tool progress toggle', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('defaults to undefined (off)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    expect(loadConfig(path).sdk.toolProgress).toBeUndefined();
  });

  it('reads sdk.toolProgress=true from the config file', () => {
    const path = writeConfig({
      botToken: 'bf_t',
      apiUrl: 'https://a',
      sdk: { toolProgress: true },
    });
    expect(loadConfig(path).sdk.toolProgress).toBe(true);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', 'On'])(
    'CC_OCTO_SDK_TOOL_PROGRESS=%s enables it',
    (val) => {
      const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
      process.env.CC_OCTO_SDK_TOOL_PROGRESS = val;
      expect(loadConfig(path).sdk.toolProgress).toBe(true);
    },
  );

  it.each(['false', '0', 'no', 'off', ''])(
    'CC_OCTO_SDK_TOOL_PROGRESS=%s disables it',
    (val) => {
      const path = writeConfig({
        botToken: 'bf_t',
        apiUrl: 'https://a',
        sdk: { toolProgress: true },
      });
      process.env.CC_OCTO_SDK_TOOL_PROGRESS = val;
      expect(loadConfig(path).sdk.toolProgress).toBe(false);
    },
  );
});

// ─── v0.3: multi-bot (resolveBotConfigs) ───────────────────────────────

describe('v0.3: resolveBotConfigs', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('single-bot config resolves to one entry with botId "default"', () => {
    const cfg = loadConfig(writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' }));
    const bots = resolveBotConfigs(cfg);
    expect(bots).toHaveLength(1);
    expect(bots[0].botId).toBe('default');
    expect(bots[0].botToken).toBe('bf_t');
  });

  it('expands a bots[] array into one config per entry', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      dataDir: '/data',
      cwdBase: '/sand',
      bots: [
        { id: 'support', botToken: 'bf_1' },
        { id: 'ops', botToken: 'bf_2' },
      ],
    }));
    const bots = resolveBotConfigs(cfg);
    expect(bots.map((b) => b.botId)).toEqual(['support', 'ops']);
    expect(bots.map((b) => b.botToken)).toEqual(['bf_1', 'bf_2']);
  });

  it('namespaces dataDir + cwdBase per bot id by default (isolation)', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      dataDir: '/data',
      cwdBase: '/sand',
      bots: [{ id: 'support', botToken: 'bf_1' }],
    }));
    const [bot] = resolveBotConfigs(cfg);
    expect(bot.dataDir).toBe('/data/support');
    expect(bot.cwdBase).toBe('/sand/support');
  });

  it('honors explicit per-bot dataDir/cwdBase overrides', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'x', botToken: 'bf_1', dataDir: '/custom/d', cwdBase: '/custom/c' }],
    }));
    const [bot] = resolveBotConfigs(cfg);
    expect(bot.dataDir).toBe('/custom/d');
    expect(bot.cwdBase).toBe('/custom/c');
  });

  it('applies per-bot model/systemPrompt overrides onto sdk', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      sdk: { model: 'base-model' },
      bots: [
        { id: 'a', botToken: 'bf_1', model: 'opus' },
        { id: 'b', botToken: 'bf_2' }, // inherits base model
      ],
    }));
    const bots = resolveBotConfigs(cfg);
    expect(bots[0].sdk.model).toBe('opus');
    expect(bots[1].sdk.model).toBe('base-model');
  });

  it('per-bot config carries no nested bots field', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_1' }],
    }));
    expect(resolveBotConfigs(cfg)[0].bots).toBeUndefined();
  });

  it('throws on a missing per-bot token', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: '' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/missing required botToken/i);
  });

  it('throws on duplicate bot ids', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'x', botToken: 'bf_1' }, { id: 'x', botToken: 'bf_2' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/duplicate bot id/i);
  });

  it('throws on duplicate bot tokens', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_same' }, { id: 'b', botToken: 'bf_same' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/duplicate botToken/i);
  });

  it('loadConfig allows a missing top-level botToken when bots[] is present', () => {
    // No top-level botToken, but bots provide their own.
    expect(() => loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_1' }],
    }))).not.toThrow();
  });

  it('rejects an unsafe per-bot apiUrl override', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_1', apiUrl: 'http://169.254.169.254' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/unsafe apiUrl/i);
  });

  it.each(['../ops', 'a/b', '.', '..', 'a\\b', 'with space'])(
    'rejects path-traversal/invalid bot id %j',
    (badId) => {
      const cfg = loadConfig(writeConfig({
        apiUrl: 'https://a',
        bots: [{ id: badId, botToken: 'bf_1' }],
      }));
      expect(() => resolveBotConfigs(cfg)).toThrow(/invalid bot id/i);
    },
  );

  it('accepts conservative slug ids', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'support-bot.1_v2', botToken: 'bf_1' }],
    }));
    expect(resolveBotConfigs(cfg)[0].botId).toBe('support-bot.1_v2');
  });
});

// ─── v0.3: sdk.persistentSession ───────────────────────────────────────

describe('v0.3: persistent session toggle', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('defaults to undefined (off)', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    expect(loadConfig(path).sdk.persistentSession).toBeUndefined();
  });

  it('reads sdk.persistentSession=true from the config file', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a', sdk: { persistentSession: true },
    });
    expect(loadConfig(path).sdk.persistentSession).toBe(true);
  });

  it.each(['true', '1', 'yes', 'on'])('CC_OCTO_SDK_PERSISTENT_SESSION=%s enables it', (val) => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    process.env.CC_OCTO_SDK_PERSISTENT_SESSION = val;
    expect(loadConfig(path).sdk.persistentSession).toBe(true);
  });

  it.each(['false', '0', 'off', ''])('CC_OCTO_SDK_PERSISTENT_SESSION=%s disables it', (val) => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a', sdk: { persistentSession: true },
    });
    process.env.CC_OCTO_SDK_PERSISTENT_SESSION = val;
    expect(loadConfig(path).sdk.persistentSession).toBe(false);
  });
});

// ─── v1.0: groupConfigDir trust-boundary validation ────────────────────

describe('v1.0: groupConfigDir must be outside cwdBase', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('accepts a groupConfigDir outside cwdBase', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/srv/octo/sandboxes', groupConfigDir: '/srv/octo/groups',
    });
    expect(loadConfig(path).groupConfigDir).toBe('/srv/octo/groups');
  });

  it('rejects groupConfigDir equal to cwdBase', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/srv/octo', groupConfigDir: '/srv/octo',
    });
    expect(() => loadConfig(path)).toThrow(/Unsafe groupConfigDir/);
  });

  it('rejects groupConfigDir nested under cwdBase (file config)', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/srv/octo', groupConfigDir: '/srv/octo/groups',
    });
    expect(() => loadConfig(path)).toThrow(/Unsafe groupConfigDir/);
  });

  it('rejects nested groupConfigDir expressed with .. (resolved-path check)', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/srv/octo', groupConfigDir: '/srv/octo/x/../groups',
    });
    expect(() => loadConfig(path)).toThrow(/Unsafe groupConfigDir/);
  });

  it('rejects nested groupConfigDir set via env (CC_OCTO_GROUP_CONFIG_DIR)', () => {
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a', cwdBase: '/srv/octo',
    });
    process.env.CC_OCTO_GROUP_CONFIG_DIR = '/srv/octo/groups';
    expect(() => loadConfig(path)).toThrow(/Unsafe groupConfigDir/);
  });

  it('does not reject a sibling dir that shares a name prefix with cwdBase', () => {
    // /srv/octo-groups is NOT inside /srv/octo — guard against naive prefix match.
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/srv/octo', groupConfigDir: '/srv/octo-groups',
    });
    expect(loadConfig(path).groupConfigDir).toBe('/srv/octo-groups');
  });
});

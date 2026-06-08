/**
 * Config tests.
 *
 * Coverage:
 *  - loadConfig file-over-defaults priority
 *  - Required field validation (botToken / apiUrl)
 *  - Invalid JSON error message includes file path
 *  - _-prefix key filtering
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig, resolveBotConfigs, loadSoul } from '../config.js';

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
  'CC_OCTO_TRANSPORT', 'CC_OCTO_WEBHOOK_HOST', 'CC_OCTO_WEBHOOK_PORT',
  'CC_OCTO_WEBHOOK_PATH', 'CC_OCTO_WEBHOOK_SECRET',
  'CC_OCTO_MEMORY_BASE',
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

// Write a GLOBAL config.json into tmpDir. baseDir = tmpDir (the file's dir), so
// resolved per-bot dirs are <tmpDir>/<botId>/{data,workspace,memory}. Dirs are
// NOT config inputs — they're derived — so fixtures never set them.
function writeConfig(obj: Record<string, unknown>, filename = 'config.json'): string {
  const path = join(tmpDir, filename);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

// Write a per-bot <tmpDir>/<id>/config.json (the high-priority override layer).
function writeBotConfig(id: string, obj: Record<string, unknown>): void {
  const dir = join(tmpDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
}

// ─── 1. Defaults ────────────────────────────────────────────────────────────

describe('loadConfig defaults', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('returns correct shared defaults; baseDir = config dir; dirs derived per bot', () => {
    const path = writeConfig({ botToken: 'bf_test', apiUrl: 'https://api.test' });
    const cfg = loadConfig(path);

    expect(cfg.botToken).toBe('bf_test');
    expect(cfg.apiUrl).toBe('https://api.test');
    // baseDir is the directory containing config.json.
    expect(cfg.baseDir).toBe(tmpDir);
    // Q2: default is the wildcard sentinel — no whitelist applied at the SDK layer.
    expect(cfg.sdk.allowedTools).toBe('*');
    expect(cfg.sdk.permissionMode).toBe('bypassPermissions');
    // #100: project-scope by default so the SDK discovers sandbox .claude/skills/.
    // Memory stays isolated via the inline autoMemoryDirectory pin.
    expect(cfg.sdk.settingSources).toEqual(['project']);
    expect(cfg.sdk.anthropicBaseUrl).toBeUndefined(); // Q1: unset by default
    expect(cfg.rateLimit.maxPerMinute).toBe(5);
    expect(cfg.context.maxContextChars).toBe(6000);
    expect(cfg.context.historyLimit).toBe(40);
    expect(cfg.botBlocklist).toBeUndefined();

    // Per-bot dirs are derived under <baseDir>/<botId>/… (single bot → default).
    const [bot] = resolveBotConfigs(cfg);
    expect(bot.botId).toBe('default');
    expect(bot.dataDir).toBe(`${tmpDir}/default/data`);
    expect(bot.cwdBase).toBe(`${tmpDir}/default/workspace`);
    expect(bot.memoryBase).toBe(`${tmpDir}/default/memory`);
    // #100: skill dirs derived (per-bot + install-wide global).
    expect(bot.skillsDir).toBe(`${tmpDir}/default/skills`);
    expect(bot.globalSkillsDir).toBe(`${tmpDir}/skills`);
  });
});

// ─── 2. Config File over Defaults ───────────────────────────────────────────

describe('config-file over defaults', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('file overrides defaults', () => {
    const path = writeConfig({
      botToken: 'bf_file',
      apiUrl: 'https://file.test',
      rateLimit: { maxPerMinute: 10 },
    });
    const cfg = loadConfig(path);
    expect(cfg.apiUrl).toBe('https://file.test');
    expect(cfg.rateLimit.maxPerMinute).toBe(10);
  });
});

// ─── 3. Required Fields ────────────────────────────────────────────────────

describe('required field validation', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('loadConfig does NOT require botToken (it lives in the per-bot config)', () => {
    // botToken is validated per-bot in resolveBotConfigs, not in loadConfig.
    const path = writeConfig({ apiUrl: 'https://api.test' });
    expect(() => loadConfig(path)).not.toThrow();
  });

  it('throws when apiUrl is missing', () => {
    const path = writeConfig({ botToken: 'bf_test' });
    expect(() => loadConfig(path)).toThrow(/apiUrl/);
  });

  it('resolveBotConfigs throws when a bot has no token (single-bot)', () => {
    const path = writeConfig({ apiUrl: 'https://api.test' });
    expect(() => resolveBotConfigs(loadConfig(path))).toThrow(/missing botToken/);
  });

  it('single-bot token can come from the global config', () => {
    const path = writeConfig({ botToken: 'bf_global', apiUrl: 'https://api.test' });
    const [bot] = resolveBotConfigs(loadConfig(path));
    expect(bot.botToken).toBe('bf_global');
    expect(bot.botId).toBe('default');
  });

  it('single-bot token can come from <baseDir>/default/config.json', () => {
    const path = writeConfig({ apiUrl: 'https://api.test' });
    writeBotConfig('default', { botToken: 'bf_perbot' });
    const [bot] = resolveBotConfigs(loadConfig(path));
    expect(bot.botToken).toBe('bf_perbot');
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

// ─── 6. Config File Missing ─────────────────────────────────────────────────

describe('missing config file', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('throws on a missing config file (apiUrl has no source)', () => {
    // With no env override path, a missing config.json leaves apiUrl unset,
    // which is a required field — loadConfig must fail loudly.
    expect(() => loadConfig(join(tmpDir, 'missing.json'))).toThrow(/apiUrl/);
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
});

// ─── Derived per-bot directories (bot-first layout) ─────────────────────

describe('derived per-bot directories', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('single bot derives <baseDir>/default/{data,workspace,memory}', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    const [bot] = resolveBotConfigs(loadConfig(path));
    expect(bot.dataDir).toBe(`${tmpDir}/default/data`);
    expect(bot.cwdBase).toBe(`${tmpDir}/default/workspace`);
    expect(bot.memoryBase).toBe(`${tmpDir}/default/memory`);
    // cwd alias stays in sync with cwdBase.
    expect(bot.cwd).toBe(bot.cwdBase);
  });

  it('dirs are NOT configurable — config-file cwdBase/dataDir/memoryBase are ignored', () => {
    // These keys are no longer part of the input schema; they must not affect
    // the derived per-bot paths.
    const path = writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      cwdBase: '/hacker/escape', dataDir: '/hacker/data', memoryBase: '/hacker/mem',
    });
    const [bot] = resolveBotConfigs(loadConfig(path));
    expect(bot.cwdBase).toBe(`${tmpDir}/default/workspace`);
    expect(bot.dataDir).toBe(`${tmpDir}/default/data`);
    expect(bot.memoryBase).toBe(`${tmpDir}/default/memory`);
  });

  it('each bot gets its own subtree under baseDir', () => {
    const path = writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'support' }, { id: 'ops' }],
    });
    writeBotConfig('support', { botToken: 'bf_s' });
    writeBotConfig('ops', { botToken: 'bf_o' });
    const bots = resolveBotConfigs(loadConfig(path));
    expect(bots[0].dataDir).toBe(`${tmpDir}/support/data`);
    expect(bots[0].memoryBase).toBe(`${tmpDir}/support/memory`);
    expect(bots[1].cwdBase).toBe(`${tmpDir}/ops/workspace`);
    // fully disjoint subtrees
    expect(bots[0].dataDir).not.toBe(bots[1].dataDir);
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
});

// ─── #100: derived skill dirs ──────────────────────────────────────────

describe('skill dirs (derived, two-layer)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('single bot: skillsDir=<baseDir>/default/skills, globalSkillsDir=<baseDir>/skills', () => {
    const path = writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' });
    const [bot] = resolveBotConfigs(loadConfig(path));
    expect(bot.skillsDir).toBe(`${tmpDir}/default/skills`);
    expect(bot.globalSkillsDir).toBe(`${tmpDir}/skills`);
  });

  it('multi-bot: each bot has its own skillsDir; global is shared', () => {
    const path = writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'alice', botToken: 'bf_a' }, { id: 'bob', botToken: 'bf_b' }],
    });
    const bots = resolveBotConfigs(loadConfig(path));
    const alice = bots.find((b) => b.botId === 'alice')!;
    const bob = bots.find((b) => b.botId === 'bob')!;
    expect(alice.skillsDir).toBe(`${tmpDir}/alice/skills`);
    expect(bob.skillsDir).toBe(`${tmpDir}/bob/skills`);
    // Global skills dir is install-wide (same for both).
    expect(alice.globalSkillsDir).toBe(`${tmpDir}/skills`);
    expect(bob.globalSkillsDir).toBe(`${tmpDir}/skills`);
  });
});

// ─── Multi-bot (resolveBotConfigs, two-layer) ──────────────────────────

describe('resolveBotConfigs (two-layer)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('single-bot config resolves to one entry with botId "default"', () => {
    const cfg = loadConfig(writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' }));
    const bots = resolveBotConfigs(cfg);
    expect(bots).toHaveLength(1);
    expect(bots[0].botId).toBe('default');
    expect(bots[0].botToken).toBe('bf_t');
  });

  it('expands a bots[] list into one config per entry; tokens from per-bot files', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'support' }, { id: 'ops' }],
    }));
    writeBotConfig('support', { botToken: 'bf_1' });
    writeBotConfig('ops', { botToken: 'bf_2' });
    const bots = resolveBotConfigs(cfg);
    expect(bots.map((b) => b.botId)).toEqual(['support', 'ops']);
    expect(bots.map((b) => b.botToken)).toEqual(['bf_1', 'bf_2']);
  });

  it('per-bot config.json overrides inline + global (token, model)', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      sdk: { model: 'base-model' },
      bots: [{ id: 'a', botToken: 'bf_inline', model: 'inline-model' }],
    }));
    // per-bot file wins over the inline bots[] entry
    writeBotConfig('a', { botToken: 'bf_file', sdk: { model: 'file-model' } });
    const [bot] = resolveBotConfigs(cfg);
    expect(bot.botToken).toBe('bf_file');
    expect(bot.sdk.model).toBe('file-model');
  });

  it('inline bots[] fields apply when no per-bot file overrides them', () => {
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

  it('throws on a bot with no token (neither inline nor per-bot file)', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/missing botToken/i);
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

  it('rejects an unsafe per-bot apiUrl override', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_1', apiUrl: 'http://169.254.169.254' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/unsafe apiUrl/i);
  });

  it('rejects groupConfigDir nested under a bot derived cwdBase', () => {
    // The bot's workspace is <baseDir>/a/workspace; a groupConfigDir inside it
    // must be rejected (the agent could write its own future instructions).
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      groupConfigDir: `${tmpDir}/a/workspace/groups`,
      bots: [{ id: 'a', botToken: 'bf_1' }],
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/Unsafe groupConfigDir/);
  });

  it('allows a groupConfigDir clear of every bot workspace', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      groupConfigDir: '/srv/octo/groups',
      bots: [{ id: 'a', botToken: 'bf_1' }],
    }));
    expect(() => resolveBotConfigs(cfg)).not.toThrow();
  });

  it.each(['../ops', 'a/b', '.', '..', 'a\\b', 'with space'])(
    'rejects path-traversal/invalid bot id %j',
    (badId) => {
      const cfg = loadConfig(writeConfig({
        apiUrl: 'https://a',
        bots: [{ id: badId, botToken: 'bf_1' }],
      }));
      expect(() => resolveBotConfigs(cfg)).toThrow(/invalid id/i);
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
});

// ─── v1.0: groupConfigDir trust-boundary validation ────────────────────

describe('v1.0: groupConfigDir must be outside cwdBase', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('accepts a groupConfigDir outside every bot workspace', () => {
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      groupConfigDir: '/srv/octo/groups',
    }));
    expect(cfg.groupConfigDir).toBe('/srv/octo/groups');
    expect(() => resolveBotConfigs(cfg)).not.toThrow();
  });

  it('rejects groupConfigDir equal to the derived bot workspace', () => {
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      groupConfigDir: `${tmpDir}/default/workspace`,
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/Unsafe groupConfigDir/);
  });

  it('rejects groupConfigDir nested under the derived bot workspace', () => {
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      groupConfigDir: `${tmpDir}/default/workspace/groups`,
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/Unsafe groupConfigDir/);
  });

  it('rejects nested groupConfigDir expressed with .. (resolved-path check)', () => {
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      groupConfigDir: `${tmpDir}/default/workspace/x/../groups`,
    }));
    expect(() => resolveBotConfigs(cfg)).toThrow(/Unsafe groupConfigDir/);
  });

  it('does not reject a sibling dir that shares a name prefix with the workspace', () => {
    // <tmpDir>/default/workspace-groups is NOT inside <tmpDir>/default/workspace.
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      groupConfigDir: `${tmpDir}/default/workspace-groups`,
    }));
    expect(() => resolveBotConfigs(cfg)).not.toThrow();
  });
});

// ─── v1.1: memoryBase (derived) ────────────────────────────────────────

describe('v1.1: memoryBase (auto-memory root, derived)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('derives to <baseDir>/<botId>/memory for a single bot', () => {
    const cfg = loadConfig(writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' }));
    expect(resolveBotConfigs(cfg)[0].memoryBase).toBe(`${tmpDir}/default/memory`);
  });

  it('is a sibling of workspace/data (not nested), so the cwd TTL never sweeps it', () => {
    const [bot] = resolveBotConfigs(loadConfig(writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' })));
    expect(bot.memoryBase).toBe(`${tmpDir}/default/memory`);
    expect(bot.cwdBase).toBe(`${tmpDir}/default/workspace`);
    // memory is NOT under workspace
    expect(bot.memoryBase!.startsWith(bot.cwdBase! + '/')).toBe(false);
  });

  it('per-bot: each bot gets its own <baseDir>/<id>/memory', () => {
    const cfg = loadConfig(writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', botToken: 'bf_1' }, { id: 'b', botToken: 'bf_2' }],
    }));
    const bots = resolveBotConfigs(cfg);
    expect(bots[0].memoryBase).toBe(`${tmpDir}/a/memory`);
    expect(bots[1].memoryBase).toBe(`${tmpDir}/b/memory`);
    expect(bots[0].memoryBase).not.toBe(bots[1].memoryBase);
  });
});

describe('v1.1: SOUL.md personality (openclaw-style)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('loadSoul returns undefined when no SOUL.md exists', () => {
    expect(loadSoul(tmpDir)).toBeUndefined();
  });

  it('loadSoul returns trimmed file contents when SOUL.md exists', () => {
    writeFileSync(join(tmpDir, 'SOUL.md'), '\n# Voice\n\nBe concise.\n\n');
    expect(loadSoul(tmpDir)).toBe('# Voice\n\nBe concise.');
  });

  it('loadSoul treats an empty/whitespace-only SOUL.md as absent', () => {
    writeFileSync(join(tmpDir, 'SOUL.md'), '   \n\t\n');
    expect(loadSoul(tmpDir)).toBeUndefined();
  });

  it('a SOUL.md in the bot subtree becomes the resolved sdk.systemPrompt', () => {
    // Single bot → subtree <tmpDir>/default/SOUL.md.
    mkdirSync(join(tmpDir, 'default'), { recursive: true });
    writeFileSync(join(tmpDir, 'default', 'SOUL.md'), 'You are Sparky. Be witty.');
    const [bot] = resolveBotConfigs(loadConfig(writeConfig({ botToken: 'bf_t', apiUrl: 'https://a' })));
    expect(bot.sdk.systemPrompt).toBe('You are Sparky. Be witty.');
  });

  it('SOUL.md takes precedence over the systemPrompt config string', () => {
    mkdirSync(join(tmpDir, 'default'), { recursive: true });
    writeFileSync(join(tmpDir, 'default', 'SOUL.md'), 'soul wins');
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      sdk: { systemPrompt: 'config string' },
    }));
    expect(resolveBotConfigs(cfg)[0].sdk.systemPrompt).toBe('soul wins');
  });

  it('falls back to the systemPrompt config string when no SOUL.md', () => {
    const cfg = loadConfig(writeConfig({
      botToken: 'bf_t', apiUrl: 'https://a',
      sdk: { systemPrompt: 'config string' },
    }));
    expect(resolveBotConfigs(cfg)[0].sdk.systemPrompt).toBe('config string');
  });

  it('per-bot: SOUL.md in the bot subtree overrides the bot systemPrompt', () => {
    // Bot 'a' subtree is <tmpDir>/a; a SOUL.md there wins over the inline
    // systemPrompt config string.
    writeBotConfig('a', { botToken: 'bf_1' });
    writeFileSync(join(tmpDir, 'a', 'SOUL.md'), 'file soul wins');
    const cfgPath = writeConfig({
      apiUrl: 'https://a',
      bots: [{ id: 'a', systemPrompt: 'bot config soul' }],
    });
    const bots = resolveBotConfigs(loadConfig(cfgPath));
    expect(bots[0].sdk.systemPrompt).toBe('file soul wins');
  });
});

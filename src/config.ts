/**
 * Configuration loading.
 * Three-level priority: env > config.json > defaults.
 */

import { readFileSync, existsSync } from 'node:fs';

export interface Config {
  botToken: string;
  apiUrl: string;
  cwd: string;
  dataDir: string;
  sdk: {
    model?: string;
    allowedTools: string[];
    permissionMode: string;
    maxTurns?: number;
    systemPrompt?: string;
    settingSources: string[];
  };
  rateLimit: {
    maxPerMinute: number;
  };
  context: {
    maxContextChars: number;
    historyLimit: number;
  };
  botBlocklist?: string[];
}

type PartialConfig = {
  botToken?: string;
  apiUrl?: string;
  cwd?: string;
  dataDir?: string;
  sdk?: Partial<Config['sdk']>;
  rateLimit?: Partial<Config['rateLimit']>;
  context?: Partial<Config['context']>;
  botBlocklist?: string[];
};

function defaults(): Config {
  return {
    botToken: '',
    apiUrl: '',
    cwd: process.cwd(),
    dataDir: './data',
    sdk: {
      allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      permissionMode: 'bypassPermissions',
      settingSources: ['user', 'project'],
    },
    rateLimit: {
      maxPerMinute: 5,
    },
    context: {
      maxContextChars: 6000,
      historyLimit: 40,
    },
  };
}

function readConfigFile(path: string): PartialConfig {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown> & PartialConfig;
  // Strip top-level keys starting with "_" (e.g. _comment).
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('_')) cleaned[k] = v;
  }
  return cleaned as PartialConfig;
}

function mergeConfig(base: Config, override: PartialConfig): Config {
  return {
    botToken: override.botToken ?? base.botToken,
    apiUrl: override.apiUrl ?? base.apiUrl,
    cwd: override.cwd ?? base.cwd,
    dataDir: override.dataDir ?? base.dataDir,
    sdk: {
      ...base.sdk,
      ...(override.sdk ?? {}),
    },
    rateLimit: {
      ...base.rateLimit,
      ...(override.rateLimit ?? {}),
    },
    context: {
      ...base.context,
      ...(override.context ?? {}),
    },
    botBlocklist: override.botBlocklist ?? base.botBlocklist,
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntStrict(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return n;
}

function applyEnv(cfg: Config): Config {
  const env = process.env;
  const next: Config = {
    ...cfg,
    sdk: { ...cfg.sdk },
    rateLimit: { ...cfg.rateLimit },
    context: { ...cfg.context },
  };

  if (env.CC_OCTO_BOT_TOKEN) next.botToken = env.CC_OCTO_BOT_TOKEN;
  if (env.CC_OCTO_API_URL) next.apiUrl = env.CC_OCTO_API_URL;
  if (env.CC_OCTO_CWD) next.cwd = env.CC_OCTO_CWD;
  if (env.CC_OCTO_DATA_DIR) next.dataDir = env.CC_OCTO_DATA_DIR;

  if (env.CC_OCTO_SDK_MODEL) next.sdk.model = env.CC_OCTO_SDK_MODEL;
  if (env.CC_OCTO_SDK_ALLOWED_TOOLS) {
    next.sdk.allowedTools = parseCsv(env.CC_OCTO_SDK_ALLOWED_TOOLS);
  }
  if (env.CC_OCTO_SDK_PERMISSION_MODE) {
    next.sdk.permissionMode = env.CC_OCTO_SDK_PERMISSION_MODE;
  }
  if (env.CC_OCTO_SDK_MAX_TURNS) {
    next.sdk.maxTurns = parseIntStrict(env.CC_OCTO_SDK_MAX_TURNS, 'CC_OCTO_SDK_MAX_TURNS');
  }
  if (env.CC_OCTO_SDK_SYSTEM_PROMPT) next.sdk.systemPrompt = env.CC_OCTO_SDK_SYSTEM_PROMPT;

  if (env.CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE) {
    next.rateLimit.maxPerMinute = parseIntStrict(
      env.CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE,
      'CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE',
    );
  }

  if (env.CC_OCTO_CONTEXT_MAX_CHARS) {
    next.context.maxContextChars = parseIntStrict(
      env.CC_OCTO_CONTEXT_MAX_CHARS,
      'CC_OCTO_CONTEXT_MAX_CHARS',
    );
  }
  if (env.CC_OCTO_CONTEXT_HISTORY_LIMIT) {
    next.context.historyLimit = parseIntStrict(
      env.CC_OCTO_CONTEXT_HISTORY_LIMIT,
      'CC_OCTO_CONTEXT_HISTORY_LIMIT',
    );
  }

  if (env.CC_OCTO_BOT_BLOCKLIST) {
    next.botBlocklist = parseCsv(env.CC_OCTO_BOT_BLOCKLIST);
  }

  return next;
}

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? './config.json';
  const fileCfg = readConfigFile(path);
  const merged = mergeConfig(defaults(), fileCfg);
  const final = applyEnv(merged);

  if (!final.botToken) {
    throw new Error('Missing required config: botToken (set CC_OCTO_BOT_TOKEN or config.json)');
  }
  if (!final.apiUrl) {
    throw new Error('Missing required config: apiUrl (set CC_OCTO_API_URL or config.json)');
  }

  return final;
}

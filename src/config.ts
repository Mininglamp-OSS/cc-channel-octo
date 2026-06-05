/**
 * Configuration loading.
 * Three-level priority: env > config.json > defaults.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAllowedApiUrl } from './url-policy.js';

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
  /** Maximum response length in chars before truncation (Q32). */
  maxResponseChars: number;
  botBlocklist?: string[];
  /**
   * G14: Bots in this list are allowed to DM the bot even if their uid matches
   * the `_bot` heuristic. Use this to whitelist trusted bots.
   */
  allowedBotUids?: string[];
  /** Group IDs where the bot responds without being @mentioned (G12). */
  mentionFreeGroups?: string[];
}

type PartialConfig = {
  botToken?: string;
  apiUrl?: string;
  cwd?: string;
  dataDir?: string;
  sdk?: Partial<Config['sdk']>;
  rateLimit?: Partial<Config['rateLimit']>;
  context?: Partial<Config['context']>;
  maxResponseChars?: number;
  botBlocklist?: string[];
  allowedBotUids?: string[];
  mentionFreeGroups?: string[];
};

function defaults(): Config {
  return {
    botToken: '',
    apiUrl: '',
    cwd: process.cwd(),
    dataDir: './data',
    sdk: {
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      permissionMode: 'bypassPermissions',
      settingSources: ['user'],
    },
    rateLimit: {
      maxPerMinute: 5,
    },
    context: {
      maxContextChars: 6000,
      historyLimit: 40,
    },
    maxResponseChars: 524_288, // 512 KB (Q32)
  };
}

function readConfigFile(configFilePath: string): PartialConfig {
  if (!existsSync(configFilePath)) {
    return {};
  }

  // Q12: Warn if config file is readable by group/others (contains botToken).
  try {
    const stat = statSync(configFilePath);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      console.warn(
        `[cc-channel-octo] WARNING: ${configFilePath} has mode ${mode.toString(8)} — ` +
        `secrets may be exposed to other users. Fix with: chmod 600 ${configFilePath}`,
      );
    }
  } catch {
    // Best-effort check — don't block startup if stat fails.
  }

  const raw = readFileSync(configFilePath, 'utf-8');
  let parsed: Record<string, unknown> & PartialConfig;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown> & PartialConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file ${configFilePath}: ${msg}`);
  }
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
    maxResponseChars: override.maxResponseChars ?? base.maxResponseChars,
    botBlocklist: override.botBlocklist ?? base.botBlocklist,
    allowedBotUids: override.allowedBotUids ?? base.allowedBotUids,
    mentionFreeGroups: override.mentionFreeGroups ?? base.mentionFreeGroups,
  };
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseIntStrict(value: string, name: string, minValue = 1): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < minValue) {
    throw new Error(`Invalid integer for ${name}: ${value} (must be >= ${minValue})`);
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
    next.sdk.maxTurns = parseIntStrict(env.CC_OCTO_SDK_MAX_TURNS, 'CC_OCTO_SDK_MAX_TURNS', 0);
  }
  if (env.CC_OCTO_SDK_SYSTEM_PROMPT) next.sdk.systemPrompt = env.CC_OCTO_SDK_SYSTEM_PROMPT;
  if (env.CC_OCTO_SDK_SETTING_SOURCES) {
    next.sdk.settingSources = parseCsv(env.CC_OCTO_SDK_SETTING_SOURCES);
  }

  if (env.CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE) {
    next.rateLimit.maxPerMinute = parseIntStrict(
      env.CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE,
      'CC_OCTO_RATE_LIMIT_MAX_PER_MINUTE',
      0,
    );
  }

  if (env.CC_OCTO_CONTEXT_MAX_CHARS) {
    next.context.maxContextChars = parseIntStrict(
      env.CC_OCTO_CONTEXT_MAX_CHARS,
      'CC_OCTO_CONTEXT_MAX_CHARS',
      0,
    );
  }
  if (env.CC_OCTO_CONTEXT_HISTORY_LIMIT) {
    next.context.historyLimit = parseIntStrict(
      env.CC_OCTO_CONTEXT_HISTORY_LIMIT,
      'CC_OCTO_CONTEXT_HISTORY_LIMIT',
      0,
    );
  }

  if (env.CC_OCTO_BOT_BLOCKLIST) {
    next.botBlocklist = parseCsv(env.CC_OCTO_BOT_BLOCKLIST);
  }

  if (env.CC_OCTO_ALLOWED_BOT_UIDS) {
    next.allowedBotUids = parseCsv(env.CC_OCTO_ALLOWED_BOT_UIDS);
  }

  if (env.CC_OCTO_MENTION_FREE_GROUPS) {
    next.mentionFreeGroups = parseCsv(env.CC_OCTO_MENTION_FREE_GROUPS);
  }

  if (env.CC_OCTO_MAX_RESPONSE_CHARS) {
    next.maxResponseChars = parseIntStrict(
      env.CC_OCTO_MAX_RESPONSE_CHARS,
      'CC_OCTO_MAX_RESPONSE_CHARS',
      1,
    );
  }

  return next;
}

/**
 * SSRF protection for apiUrl: implemented in url-policy.ts (isAllowedApiUrl).
 * S6 fix: now rejects https://127.0.0.1 too — https doesn't make a private
 * address safe (could be a self-signed mitmproxy).
 */

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
  if (!isAllowedApiUrl(final.apiUrl)) {
    throw new Error(
      `Unsafe apiUrl: ${final.apiUrl} — must be https:// or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }

  return final;
}

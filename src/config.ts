/**
 * Configuration loading.
 * Three-level priority: env > config.json > defaults.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { isAllowedApiUrl } from './url-policy.js';

/**
 * Q2: Wildcard form of `allowedTools` — `"*"` means "allow every tool the SDK
 * exposes". Otherwise must be an explicit string array (whitelist mode).
 */
export type AllowedTools = string[] | '*';

export interface Config {
  botToken: string;
  apiUrl: string;
  /**
   * Q3: Base directory for per-session cwd isolation. Each (DM peer | group |
   * thread) gets its own hashed subdirectory under this path. Resolved via
   * `cwd-resolver.resolveSessionCwd()` before passing to the SDK.
   *
   * loadConfig() always populates this. Direct Config mocks (e.g. in tests)
   * may rely on the deprecated `cwd` alias instead — call sites should read
   * `config.cwdBase ?? config.cwd` to support both.
   */
  cwdBase?: string;
  /**
   * @deprecated Use `cwdBase`. Retained as a required compat alias for one
   * release so existing tests and consumers that build Config objects by hand
   * continue to compile. loadConfig() keeps this in sync with `cwdBase`.
   */
  cwd: string;
  dataDir: string;
  sdk: {
    model?: string;
    /**
     * Q2: `"*"` allows every tool the SDK exposes; otherwise an explicit
     * whitelist. Default is `"*"` because we already control surface area via
     * `permissionMode` and `cwdBase` isolation — the old hard-coded 8-tool
     * list was redundant lockdown and broke operators who needed SDK-internal
     * tools like `TodoWrite`/`Task`.
     */
    allowedTools: AllowedTools;
    permissionMode: string;
    maxTurns?: number;
    systemPrompt?: string;
    settingSources: string[];
    /**
     * v0.3: when true, the bot sends brief "🔧 Running <tool>…" progress
     * messages as the agent invokes tools, so users see activity during long
     * tool-heavy turns. Default false — it adds extra chat messages, so it is
     * opt-in. Env: `CC_OCTO_SDK_TOOL_PROGRESS=true`.
     */
    toolProgress?: boolean;
    /**
     * Q1: Override the upstream Claude API endpoint (e.g. self-hosted gateway).
     * Forwarded to the SDK subprocess via the standard `ANTHROPIC_BASE_URL`
     * environment variable. Env priority: `ANTHROPIC_BASE_URL` > this field.
     */
    anthropicBaseUrl?: string;
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
  /** Q3: canonical field — base dir for per-session cwd isolation. */
  cwdBase?: string;
  /** Q3 deprecated alias — maps to cwdBase with a warning. */
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
    cwdBase: process.cwd(),
    cwd: process.cwd(),
    dataDir: './data',
    sdk: {
      // Q2: default to wildcard — operators tighten only when they need to.
      allowedTools: '*',
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
  // Q3: accept legacy `cwd` as an alias for `cwdBase`. cwdBase wins if both
  // are present; otherwise cwd warns and is used. Blank strings are treated as
  // "not provided" so a `"cwdBase": ""` typo cannot slip past the nullish
  // fallback and land sandboxes relative to process.cwd().
  const overrideCwdBase = nonBlank(override.cwdBase);
  const overrideCwd = nonBlank(override.cwd);
  let cwdBase = overrideCwdBase ?? base.cwdBase ?? base.cwd;
  if (overrideCwdBase === undefined && overrideCwd !== undefined) {
    console.warn(
      '[cc-channel-octo] WARNING: config.cwd is deprecated, use config.cwdBase instead',
    );
    cwdBase = overrideCwd;
  }
  return {
    botToken: override.botToken ?? base.botToken,
    apiUrl: override.apiUrl ?? base.apiUrl,
    cwdBase,
    // Keep deprecated `cwd` in sync so any legacy reader still sees a value.
    cwd: cwdBase ?? base.cwd,
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

/** Return the trimmed value, or undefined when it is missing/blank. */
function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  // Q3: CC_OCTO_CWDBASE wins; CC_OCTO_CWD is accepted with a deprecation warning.
  // Blank/whitespace-only values are ignored (treated as unset).
  const envCwdBase = nonBlank(env.CC_OCTO_CWDBASE);
  const envCwd = nonBlank(env.CC_OCTO_CWD);
  if (envCwdBase) {
    next.cwdBase = envCwdBase;
    next.cwd = envCwdBase;
  } else if (envCwd) {
    console.warn(
      '[cc-channel-octo] WARNING: CC_OCTO_CWD is deprecated, use CC_OCTO_CWDBASE instead',
    );
    next.cwdBase = envCwd;
    next.cwd = envCwd;
  }
  if (env.CC_OCTO_DATA_DIR) next.dataDir = env.CC_OCTO_DATA_DIR;

  if (env.CC_OCTO_SDK_MODEL) next.sdk.model = env.CC_OCTO_SDK_MODEL;
  if (env.CC_OCTO_SDK_ALLOWED_TOOLS) {
    // Q2: a `*` token anywhere in the value means "allow every tool" — collapse
    // to the wildcard sentinel rather than passing a literal `*` through as a
    // (bogus) tool name. So `*`, ` * `, and `*,Read` all mean wildcard.
    const tools = parseCsv(env.CC_OCTO_SDK_ALLOWED_TOOLS);
    next.sdk.allowedTools = tools.includes('*') ? '*' : tools;
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
  // v0.3: tool-progress messages. Accept the usual truthy spellings.
  if (env.CC_OCTO_SDK_TOOL_PROGRESS !== undefined) {
    next.sdk.toolProgress = /^(1|true|yes|on)$/i.test(env.CC_OCTO_SDK_TOOL_PROGRESS.trim());
  }
  // Q1: ANTHROPIC_BASE_URL uses the Anthropic SDK standard variable name
  // (no CC_OCTO_ prefix) so operators can reuse existing gateway configs.
  if (env.ANTHROPIC_BASE_URL) {
    next.sdk.anthropicBaseUrl = env.ANTHROPIC_BASE_URL;
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
  // Q1: the gateway endpoint receives the Anthropic API key and all prompt /
  // response content, so it gets the same SSRF policy as apiUrl. Without this,
  // a stray ANTHROPIC_BASE_URL (e.g. inherited from a shared shell profile or
  // CI env) could silently redirect every model request — and the credential —
  // to an attacker-controlled or private-network host.
  if (final.sdk.anthropicBaseUrl && !isAllowedApiUrl(final.sdk.anthropicBaseUrl)) {
    throw new Error(
      `Unsafe sdk.anthropicBaseUrl: ${final.sdk.anthropicBaseUrl} — must be https:// ` +
      `or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }

  return final;
}

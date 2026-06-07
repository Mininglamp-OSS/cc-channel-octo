/**
 * Configuration loading.
 * Three-level priority: env > config.json > defaults.
 */

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
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
  /**
   * v1.0: directory of per-group instruction files (`<groupId>.md`). When set,
   * a matching file's contents are injected into the system prompt as trusted
   * custom instructions for that group. Operator-controlled — must NOT be the
   * per-session cwd sandbox (which the agent can write). Unset = feature off.
   */
  groupConfigDir?: string;
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
     * v0.3: when true, use the SDK's v2 Session API to persist agent workspace
     * state across messages — each session's SDK session id is stored and
     * `resume`d on the next turn, so open files / command history / context
     * survive between messages. Default false (the proven stateless v1 `query()`
     * path). Env: `CC_OCTO_SDK_PERSISTENT_SESSION=true`.
     */
    persistentSession?: boolean;
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
  /**
   * v0.3 multi-bot: optional per-bot overrides. When present and non-empty, the
   * process runs ONE independent bot per entry, each with its own gateway,
   * router, store, and (by default) data directory — so bots never share history
   * or working dirs. Each entry inherits every top-level field and overrides the
   * listed ones; `botToken` is required per entry. When absent, the process runs
   * a single bot from the top-level fields exactly as before.
   *
   * Resolved into concrete per-bot Config objects by `resolveBotConfigs()`.
   */
  bots?: BotOverride[];
  /**
   * v0.3 multi-bot: stable identifier for THIS bot, used to namespace its data
   * directory and logs when running multiple bots. Defaults to `default` for the
   * single-bot case. Populated by `resolveBotConfigs()`.
   */
  botId?: string;
}

/**
 * v0.3 multi-bot: one bot's overrides layered on the base config. Every field is
 * optional except `botToken` (each bot needs its own identity). An omitted field
 * inherits the top-level value.
 */
export interface BotOverride {
  /**
   * Stable id used to namespace this bot's data dir / sandbox (e.g. `support`,
   * `ops`). RECOMMENDED — when omitted it defaults to the positional `bot<N>`
   * (bot0, bot1, …), which works but produces less stable, index-dependent
   * directory names (reordering the array changes them). Must be a conservative
   * slug: letters, digits, dot, underscore, hyphen — no path separators.
   */
  id?: string;
  /** Required — this bot's Octo bot token. */
  botToken: string;
  apiUrl?: string;
  dataDir?: string;
  cwdBase?: string;
  model?: string;
  systemPrompt?: string;
  botBlocklist?: string[];
  allowedBotUids?: string[];
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
  groupConfigDir?: string;
  sdk?: Partial<Config['sdk']>;
  rateLimit?: Partial<Config['rateLimit']>;
  context?: Partial<Config['context']>;
  maxResponseChars?: number;
  botBlocklist?: string[];
  allowedBotUids?: string[];
  mentionFreeGroups?: string[];
  bots?: BotOverride[];
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
    groupConfigDir: override.groupConfigDir ?? base.groupConfigDir,
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
    bots: override.bots ?? base.bots,
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
  if (env.CC_OCTO_GROUP_CONFIG_DIR) next.groupConfigDir = env.CC_OCTO_GROUP_CONFIG_DIR;

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
  // v0.3: persistent (v2) sessions.
  if (env.CC_OCTO_SDK_PERSISTENT_SESSION !== undefined) {
    next.sdk.persistentSession = /^(1|true|yes|on)$/i.test(env.CC_OCTO_SDK_PERSISTENT_SESSION.trim());
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

  const hasBots = Array.isArray(final.bots) && final.bots.length > 0;

  // In multi-bot mode the per-bot tokens live in `bots[]`, so the top-level
  // botToken is optional; resolveBotConfigs() validates each entry's token.
  if (!final.botToken && !hasBots) {
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

  // v1.0 GROUP.md trust boundary — checked here for the single-bot/top-level
  // case; resolveBotConfigs() re-checks each bot AFTER applying per-bot cwdBase
  // overrides (a per-bot cwdBase could otherwise swallow groupConfigDir).
  assertGroupConfigDirOutsideCwd(final);

  return final;
}

/**
 * Enforce that `groupConfigDir` (whose files are injected UNSANITIZED into the
 * system prompt) is not the same as, nor nested under, the agent-writable
 * `cwdBase`. Otherwise a user-driven agent could write its own future
 * system-prompt instructions.
 *
 * Uses realpathSync.native for paths that exist (so symlinks can't dodge the
 * boundary) and falls back to lexical resolve() for not-yet-created dirs.
 */
function assertGroupConfigDirOutsideCwd(cfg: Config): void {
  if (!cfg.groupConfigDir) return;
  const cwdBase = cfg.cwdBase ?? cfg.cwd;
  const cwdBaseResolved = canonicalize(cwdBase);
  const groupDirResolved = canonicalize(cfg.groupConfigDir);
  if (groupDirResolved === cwdBaseResolved || isPathInside(groupDirResolved, cwdBaseResolved)) {
    throw new Error(
      `Unsafe groupConfigDir: ${cfg.groupConfigDir} is the same as or nested under ` +
      `cwdBase (${cwdBase}). It must be operator-controlled and outside the ` +
      `agent-writable sandbox, since its files are injected into the system prompt.`,
    );
  }
}

/** Resolve to a real path when it exists (defeats symlink dodges), else lexical. */
function canonicalize(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolvePath(p);
  }
}

/** True when `child` is strictly inside `parent` (both already resolved). */
function isPathInside(child: string, parent: string): boolean {
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

/**
 * v0.3 multi-bot: expand a loaded Config into one concrete Config per bot.
 *
 * - Single-bot (no `bots`): returns `[config]` with `botId` defaulted to
 *   `default`, unchanged otherwise — fully backward compatible.
 * - Multi-bot: returns one Config per `bots[]` entry. Each inherits the base
 *   config and applies its overrides. To guarantee bots never share history,
 *   cwd, or lock files, each bot's `dataDir` and `cwdBase` are namespaced by its
 *   id UNLESS the entry sets them explicitly.
 *
 * Throws on missing/duplicate bot tokens or duplicate ids (fail fast at boot).
 */
export function resolveBotConfigs(config: Config): Config[] {
  const bots = config.bots;
  if (!bots || bots.length === 0) {
    return [{ ...config, botId: config.botId ?? 'default' }];
  }

  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  return bots.map((bot, i) => {
    if (!bot.botToken) {
      throw new Error(`Multi-bot: bots[${i}] is missing required botToken`);
    }
    const id = bot.id ?? `bot${i}`;
    // The id becomes a path segment for the default dataDir/cwdBase namespace,
    // so restrict it to a conservative slug — otherwise ids like "../ops" or
    // "a/b" could escape or alias the intended per-bot directory, defeating the
    // isolation the feature promises.
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(
        `Multi-bot: invalid bot id "${id}" — use only letters, digits, dot, underscore, hyphen (no path separators)`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Multi-bot: duplicate bot id "${id}" — ids must be unique`);
    }
    seenIds.add(id);
    if (seenTokens.has(bot.botToken)) {
      throw new Error(`Multi-bot: duplicate botToken across bots — each bot needs a distinct token`);
    }
    seenTokens.add(bot.botToken);

    // Namespace data dir + cwd base by id so bots are isolated by default.
    const baseDataDir = config.dataDir;
    const baseCwd = config.cwdBase ?? config.cwd;
    const resolved: Config = {
      ...config,
      bots: undefined, // a per-bot config is single-bot
      botId: id,
      botToken: bot.botToken,
      apiUrl: bot.apiUrl ?? config.apiUrl,
      dataDir: bot.dataDir ?? joinPath(baseDataDir, id),
      cwdBase: bot.cwdBase ?? joinPath(baseCwd, id),
      cwd: bot.cwdBase ?? joinPath(baseCwd, id),
      botBlocklist: bot.botBlocklist ?? config.botBlocklist,
      allowedBotUids: bot.allowedBotUids ?? config.allowedBotUids,
      mentionFreeGroups: bot.mentionFreeGroups ?? config.mentionFreeGroups,
      sdk: {
        ...config.sdk,
        ...(bot.model !== undefined ? { model: bot.model } : {}),
        ...(bot.systemPrompt !== undefined ? { systemPrompt: bot.systemPrompt } : {}),
      },
    };
    if (!isAllowedApiUrl(resolved.apiUrl)) {
      throw new Error(
        `Multi-bot: unsafe apiUrl for bot "${id}": ${resolved.apiUrl} (SSRF protection)`,
      );
    }
    // Re-check the GROUP.md trust boundary against THIS bot's resolved cwdBase
    // (a per-bot cwdBase override could place groupConfigDir inside the bot's
    // own writable sandbox, which the top-level check in loadConfig can't see).
    assertGroupConfigDirOutsideCwd(resolved);
    return resolved;
  });
}

/** Join two path segments without importing node:path into the type surface. */
function joinPath(a: string, b: string): string {
  return a.replace(/\/+$/, '') + '/' + b;
}

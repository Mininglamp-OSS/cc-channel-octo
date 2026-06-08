/**
 * Configuration loading.
 *
 * Two-layer, bot-first model:
 *  - GLOBAL `~/.cc-channel-octo/config.json` — shared defaults + a `bots` list.
 *    Never holds a botToken.
 *  - PER-BOT `~/.cc-channel-octo/<id>/config.json` — that bot's botToken + any
 *    overrides. Each bot is a self-contained subtree:
 *      <baseDir>/<id>/{config.json, SOUL.md, data/, workspace/, memory/}
 *  - `baseDir` is the directory containing the global config.json. Per-bot dirs
 *    are DERIVED from `<baseDir>/<id>/…` (not separately configurable) so a bot
 *    can never point its data outside its own subtree.
 *
 * env overrides still apply to the shared/global layer.
 */

import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, sep, dirname, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { isAllowedApiUrl } from './url-policy.js';

/**
 * Default global config path: `~/.cc-channel-octo/config.json`. This is the
 * single, fixed production location (no env/CLI override). Tests pass an
 * explicit path, which also sets `baseDir` to that file's directory.
 */
export const DEFAULT_CONFIG_PATH = pathJoin(homedir(), '.cc-channel-octo', 'config.json');

/**
 * Q2: Wildcard form of `allowedTools` — `"*"` means "allow every tool the SDK
 * exposes". Otherwise must be an explicit string array (whitelist mode).
 */
export type AllowedTools = string[] | '*';

export interface Config {
  botToken: string;
  apiUrl: string;
  /**
   * Base directory containing the global config.json. Every bot's subtree lives
   * at `<baseDir>/<botId>/…`. Defaults to `~/.cc-channel-octo` (the dir of
   * DEFAULT_CONFIG_PATH); when an explicit config path is passed, it is that
   * file's directory.
   */
  baseDir: string;
  /**
   * DERIVED (not user-configurable): per-session cwd sandbox base for THIS bot,
   * `<baseDir>/<botId>/workspace`. Each (DM peer | group channel) gets its own
   * hashed subdir under it via `cwd-resolver.resolveSessionCwd()`. Populated by
   * `resolveBotConfigs()`.
   */
  cwdBase?: string;
  /**
   * @deprecated Alias of `cwdBase`, kept in sync so hand-built Config objects
   * (tests, legacy consumers reading `config.cwd`) still compile.
   */
  cwd: string;
  /**
   * DERIVED (not user-configurable): SQLite/data dir for THIS bot,
   * `<baseDir>/<botId>/data`. Populated by `resolveBotConfigs()`.
   */
  dataDir: string;
  /**
   * DERIVED (not user-configurable): SDK auto-memory base for THIS bot,
   * `<baseDir>/<botId>/memory`. Each session gets a hashed subdir under it (same
   * partitioning as the cwd sandbox: group=shared per channel, DM=private per
   * peer). Separate from the cwd sandbox so the 7-day cwd TTL never reclaims
   * memory. Populated by `resolveBotConfigs()`.
   */
  memoryBase?: string;
  /**
   * v1.0: directory of per-group instruction files (`<groupId>.md`). When set,
   * a matching file's contents are injected into the system prompt as trusted
   * custom instructions for that group. Operator-controlled — must NOT be the
   * per-session cwd sandbox (which the agent can write). Unset = feature off.
   */
  groupConfigDir?: string;
  /**
   * v1.0: inbound transport. `websocket` (default) keeps the WuKongIM long
   * connection. `webhook` instead runs a small HTTP server that receives Octo
   * message webhooks and feeds the same pipeline (see `webhook`). The bot still
   * registers over REST either way (for botId/ownerUid and outbound sends).
   */
  transport?: 'websocket' | 'webhook';
  /** v1.0: webhook-mode HTTP server settings (used when transport='webhook'). */
  webhook?: {
    /** Bind host. Default `127.0.0.1` — keep it local behind a reverse proxy. */
    host?: string;
    /** Bind port. Default `8787`. */
    port?: number;
    /** Path that accepts message POSTs. Default `/octo/webhook`. */
    path?: string;
    /**
     * Shared secret. A request must present it (header `x-webhook-secret` or
     * `?secret=`) or it is rejected 401. REQUIRED when transport='webhook' —
     * loadConfig throws if missing, since an unauthenticated endpoint would let
     * anyone inject messages.
     */
    secret?: string;
  };
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
    /**
     * Which filesystem settings sources the SDK loads (`user`/`project`/`local`).
     * Default is `[]` — SDK isolation mode. The bot runs as a service and must
     * NOT read or write the operator's real `~/.claude` config: with `["user"]`
     * the agent loads the host's global `~/.claude/CLAUDE.md` into context and,
     * when told to "remember" something, writes there instead of its scoped
     * auto-memory dir (observed in live testing). Memory flows only through the
     * dedicated auto-memory directory (see `memoryBase`). Operators who
     * deliberately want host config can set `["user"]`/`["project"]`/etc.
     * Note: this controls what is LOADED (read), not what tools may write —
     * tool-write scope is governed by `permissionMode`/`allowedTools`.
     */
    settingSources: string[];
    /**
     * v0.3: when true, the bot sends brief "🔧 Running <tool>…" progress
     * messages as the agent invokes tools, so users see activity during long
     * tool-heavy turns. Default false — it adds extra chat messages, so it is
     * opt-in. Env: `CC_OCTO_SDK_TOOL_PROGRESS=true`.
     */
    toolProgress?: boolean;
    /**
     * #87: when true, expose the read-only Octo management tool server to the
     * agent (list_groups, group_info, group_members, search_members) so the
     * model can answer questions about the bot's groups/members. Default false
     * (opt-in — it widens the agent's reach). Env: `CC_OCTO_SDK_OCTO_TOOLS=true`.
     */
    octoTools?: boolean;
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
  /**
   * #86: media CDN host (no scheme), prefetched at startup from the upload-
   * credentials STS response (`cdnBaseUrl`). Octo serves media from a separate
   * CDN host than `apiUrl`; inbound media URLs on this host are allowed by
   * buildMediaUrl. Runtime-populated (not from the config file); undefined until
   * the prefetch succeeds, in which case only same-apiUrl-host media is allowed.
   */
  mediaCdnHost?: string;
}

/**
 * One bot's entry. In the two-layer model the global config's `bots` array
 * lists which bots to run (by `id`); each bot's real settings — including its
 * required `botToken` — live in `<baseDir>/<id>/config.json`, which is merged
 * OVER both the global shared fields and any inline fields here (per-dir wins).
 *
 * Per-bot directories are NOT configurable here: they are always derived as
 * `<baseDir>/<id>/{data,workspace,memory}` so a bot cannot escape its subtree.
 */
export interface BotOverride {
  /**
   * Stable id — also the bot's subtree name under `baseDir`. Required in the
   * two-layer model (it selects `<baseDir>/<id>/config.json`). Must be a
   * conservative slug: letters, digits, dot, underscore, hyphen — no path
   * separators (it becomes a path segment).
   */
  id?: string;
  /**
   * Optional here — normally provided by the per-bot `<id>/config.json`. If set
   * inline it is used unless the per-bot file overrides it.
   */
  botToken?: string;
  apiUrl?: string;
  model?: string;
  systemPrompt?: string;
  botBlocklist?: string[];
  allowedBotUids?: string[];
  mentionFreeGroups?: string[];
  /** v1.0: per-bot inbound transport (defaults to the shared `transport`). */
  transport?: 'websocket' | 'webhook';
  /**
   * v1.0: per-bot webhook server settings, merged over the shared `webhook`.
   * In multi-bot webhook mode each bot MUST bind a distinct host:port (and may
   * use distinct paths/secrets); resolveBotConfigs() rejects colliding binds.
   */
  webhook?: {
    host?: string;
    port?: number;
    path?: string;
    secret?: string;
  };
}

type PartialConfig = {
  botToken?: string;
  apiUrl?: string;
  groupConfigDir?: string;
  transport?: 'websocket' | 'webhook';
  webhook?: Partial<Config['webhook']>;
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
    // baseDir is set by loadConfig() from the config path's directory; the
    // per-bot dirs below are DERIVED in resolveBotConfigs() as
    // <baseDir>/<botId>/{workspace,data,memory}. Left empty here.
    baseDir: '',
    cwdBase: '',
    cwd: '',
    dataDir: '',
    memoryBase: '',
    sdk: {
      // Q2: default to wildcard — operators tighten only when they need to.
      allowedTools: '*',
      permissionMode: 'bypassPermissions',
      // v1.1: SDK isolation mode by default — never touch the host's ~/.claude.
      settingSources: [],
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
    // baseDir + derived dirs are filled by loadConfig()/resolveBotConfigs(),
    // not by config-file merge.
    baseDir: base.baseDir,
    cwdBase: base.cwdBase,
    cwd: base.cwd,
    dataDir: base.dataDir,
    memoryBase: base.memoryBase,
    groupConfigDir: override.groupConfigDir ?? base.groupConfigDir,
    transport: override.transport ?? base.transport,
    webhook: (override.webhook || base.webhook)
      ? { ...base.webhook, ...(override.webhook ?? {}) }
      : undefined,
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

  // Fail loudly on REMOVED directory env vars instead of silently ignoring them.
  // Dirs are now derived from baseDir (<baseDir>/<id>/{data,workspace,memory}),
  // so a deploy that still sets e.g. CC_OCTO_DATA_DIR=/mnt/vol would otherwise
  // write under ~/.cc-channel-octo and quietly miss its mounted volume.
  const removedDirEnv = ['CC_OCTO_CWDBASE', 'CC_OCTO_CWD', 'CC_OCTO_DATA_DIR', 'CC_OCTO_MEMORY_BASE']
    .filter((k) => env[k] !== undefined && env[k] !== '');
  if (removedDirEnv.length > 0) {
    throw new Error(
      `Removed config env var(s): ${removedDirEnv.join(', ')}. Per-bot directories ` +
      `are no longer configurable — they are derived as <baseDir>/<botId>/{data,` +
      `workspace,memory}, where baseDir is the directory of ~/.cc-channel-octo/config.json. ` +
      `Move data by relocating ~/.cc-channel-octo (e.g. a symlink to your volume) and ` +
      `unset these variables.`,
    );
  }

  if (env.CC_OCTO_BOT_TOKEN) next.botToken = env.CC_OCTO_BOT_TOKEN;
  if (env.CC_OCTO_API_URL) next.apiUrl = env.CC_OCTO_API_URL;
  if (env.CC_OCTO_GROUP_CONFIG_DIR) next.groupConfigDir = env.CC_OCTO_GROUP_CONFIG_DIR;
  // v1.0 webhook transport env overrides.
  if (env.CC_OCTO_TRANSPORT) {
    const t = env.CC_OCTO_TRANSPORT.trim().toLowerCase();
    if (t === 'websocket' || t === 'webhook') next.transport = t;
  }
  if (
    env.CC_OCTO_WEBHOOK_HOST || env.CC_OCTO_WEBHOOK_PORT ||
    env.CC_OCTO_WEBHOOK_PATH || env.CC_OCTO_WEBHOOK_SECRET
  ) {
    next.webhook = { ...next.webhook };
    if (env.CC_OCTO_WEBHOOK_HOST) next.webhook.host = env.CC_OCTO_WEBHOOK_HOST;
    if (env.CC_OCTO_WEBHOOK_PORT) {
      next.webhook.port = parseIntStrict(env.CC_OCTO_WEBHOOK_PORT, 'CC_OCTO_WEBHOOK_PORT', 1);
    }
    if (env.CC_OCTO_WEBHOOK_PATH) next.webhook.path = env.CC_OCTO_WEBHOOK_PATH;
    if (env.CC_OCTO_WEBHOOK_SECRET) next.webhook.secret = env.CC_OCTO_WEBHOOK_SECRET;
  }

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
  // #87: read-only Octo management tool server (opt-in).
  if (env.CC_OCTO_SDK_OCTO_TOOLS !== undefined) {
    next.sdk.octoTools = /^(1|true|yes|on)$/i.test(env.CC_OCTO_SDK_OCTO_TOOLS.trim());
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
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  // Migration aid: if the fixed global config is missing but a legacy
  // ./config.json exists in the cwd, point the operator at the move rather than
  // failing later with a cryptic "Missing required config: apiUrl".
  if (configPath === undefined && !existsSync(path) && existsSync('./config.json')) {
    throw new Error(
      `No config at ${path}, but ./config.json exists. The config location moved: ` +
      `cc-channel-octo now loads ~/.cc-channel-octo/config.json (shared, no token) plus ` +
      `~/.cc-channel-octo/<botId>/config.json (per-bot token). Move your settings there ` +
      `(see config.example.json / config.bot.example.json).`,
    );
  }
  const fileCfg = readConfigFile(path);
  const merged = mergeConfig(defaults(), fileCfg);
  const final = applyEnv(merged);

  // baseDir = the directory containing the global config.json. Every bot's
  // subtree lives at <baseDir>/<botId>/…. resolveBotConfigs() derives the
  // per-bot dirs from this.
  final.baseDir = dirname(resolvePath(path));

  // apiUrl is shared and required at the global layer (a per-bot config.json may
  // still override it, re-checked per bot in resolveBotConfigs). botToken is NOT
  // validated here — it lives in each bot's <id>/config.json.
  if (!final.apiUrl) {
    throw new Error('Missing required config: apiUrl (set CC_OCTO_API_URL or config.json)');
  }
  if (!isAllowedApiUrl(final.apiUrl)) {
    throw new Error(
      `Unsafe apiUrl: ${final.apiUrl} — must be https:// or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }
  // Q1: the gateway endpoint receives the Anthropic API key and all prompt /
  // response content, so it gets the same SSRF policy as apiUrl.
  if (final.sdk.anthropicBaseUrl && !isAllowedApiUrl(final.sdk.anthropicBaseUrl)) {
    throw new Error(
      `Unsafe sdk.anthropicBaseUrl: ${final.sdk.anthropicBaseUrl} — must be https:// ` +
      `or http://localhost/http://127.0.0.1 (SSRF protection)`,
    );
  }

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
/**
 * Expand a loaded GLOBAL config into one concrete Config per bot.
 *
 * Two-layer, bot-first model:
 * - Single-bot (no `bots`): one bot with id `default`. Its token/overrides come
 *   from the global config and/or `<baseDir>/default/config.json`.
 * - Multi-bot: one Config per `bots[]` entry (selected by `id`). For each, the
 *   effective config is: global shared fields ⊕ inline `bots[]` fields ⊕
 *   `<baseDir>/<id>/config.json` (per-dir file wins).
 *
 * Every bot's directories are DERIVED (never configurable):
 *   data      = <baseDir>/<id>/data
 *   workspace = <baseDir>/<id>/workspace   (cwdBase)
 *   memory    = <baseDir>/<id>/memory
 * and its personality from `<baseDir>/<id>/SOUL.md` (overrides systemPrompt).
 *
 * Throws on missing/duplicate tokens, duplicate ids, invalid id slugs, unsafe
 * apiUrl, or webhook misconfig (fail fast at boot).
 */
export function resolveBotConfigs(config: Config): Config[] {
  // Single-bot: synthesize one entry with id "default".
  const entries: BotOverride[] =
    config.bots && config.bots.length > 0
      ? config.bots
      : [{ id: 'default', botToken: config.botToken || undefined }];

  const seenIds = new Set<string>();
  const seenTokens = new Set<string>();
  const resolvedBots = entries.map((bot, i) => {
    const id = bot.id ?? `bot${i}`;
    // The id becomes a path segment for the bot's subtree, so restrict it to a
    // conservative slug — otherwise ids like "../ops" or "a/b" could escape or
    // alias the intended directory, defeating isolation.
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') {
      throw new Error(
        `Bot "${id}": invalid id — use only letters, digits, dot, underscore, hyphen (no path separators)`,
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate bot id "${id}" — ids must be unique`);
    }
    seenIds.add(id);

    // Derive the bot's self-contained subtree under baseDir.
    const botRoot = pathJoin(config.baseDir, id);
    const botDataDir = pathJoin(botRoot, 'data');
    const botCwdBase = pathJoin(botRoot, 'workspace');
    const botMemoryBase = pathJoin(botRoot, 'memory');

    // Per-bot config.json (in the bot's own subtree) is the highest-priority
    // layer: global shared ⊕ inline bots[] entry ⊕ <baseDir>/<id>/config.json.
    const perBotFile = readConfigFile(pathJoin(botRoot, 'config.json'));
    const botToken = perBotFile.botToken ?? bot.botToken ?? '';
    if (!botToken) {
      throw new Error(
        `Bot "${id}": missing botToken — set it in ${pathJoin(botRoot, 'config.json')}`,
      );
    }
    if (seenTokens.has(botToken)) {
      throw new Error(`Duplicate botToken across bots — each bot needs a distinct token`);
    }
    seenTokens.add(botToken);

    // openclaw-style SOUL.md in the bot's subtree overrides systemPrompt (which
    // may come from the per-bot file, the inline entry, or the shared config).
    const botSoul = loadSoul(botRoot);
    const sharedSystemPrompt = config.sdk.systemPrompt;
    const botSystemPrompt =
      botSoul ?? perBotFile.sdk?.systemPrompt ?? bot.systemPrompt ?? sharedSystemPrompt;

    const apiUrl = perBotFile.apiUrl ?? bot.apiUrl ?? config.apiUrl;
    const transport = perBotFile.transport ?? bot.transport ?? config.transport;
    const webhook = (perBotFile.webhook || bot.webhook || config.webhook)
      ? { ...config.webhook, ...(bot.webhook ?? {}), ...(perBotFile.webhook ?? {}) }
      : undefined;
    const model = perBotFile.sdk?.model ?? bot.model ?? config.sdk.model;

    const resolved: Config = {
      ...config,
      bots: undefined, // a per-bot config is single-bot
      botId: id,
      botToken,
      apiUrl,
      baseDir: config.baseDir,
      dataDir: botDataDir,
      cwdBase: botCwdBase,
      cwd: botCwdBase,
      memoryBase: botMemoryBase,
      botBlocklist: perBotFile.botBlocklist ?? bot.botBlocklist ?? config.botBlocklist,
      allowedBotUids: perBotFile.allowedBotUids ?? bot.allowedBotUids ?? config.allowedBotUids,
      mentionFreeGroups:
        perBotFile.mentionFreeGroups ?? bot.mentionFreeGroups ?? config.mentionFreeGroups,
      groupConfigDir: perBotFile.groupConfigDir ?? config.groupConfigDir,
      transport,
      webhook,
      sdk: {
        ...config.sdk,
        ...(perBotFile.sdk ?? {}),
        ...(model !== undefined ? { model } : {}),
        ...(botSystemPrompt !== undefined ? { systemPrompt: botSystemPrompt } : {}),
      },
    };
    if (!isAllowedApiUrl(resolved.apiUrl)) {
      throw new Error(`Bot "${id}": unsafe apiUrl ${resolved.apiUrl} (SSRF protection)`);
    }
    // GROUP.md trust boundary: groupConfigDir must not be the bot's writable cwd.
    assertGroupConfigDirOutsideCwd(resolved);
    // Webhook mode needs a secret + valid path/port per bot.
    if (resolved.transport === 'webhook') {
      if (!resolved.webhook?.secret) {
        throw new Error(
          `Bot "${id}": webhook transport requires webhook.secret — an unauthenticated ` +
          `endpoint would let anyone inject messages.`,
        );
      }
      const wpath = resolved.webhook?.path;
      if (wpath !== undefined && !wpath.startsWith('/')) {
        throw new Error(`Bot "${id}": invalid webhook.path "${wpath}" — must start with "/"`);
      }
      const wport = resolved.webhook?.port;
      if (wport !== undefined && (!Number.isInteger(wport) || wport < 1 || wport > 65535)) {
        throw new Error(`Bot "${id}": invalid webhook.port ${wport} — must be an integer in 1..65535`);
      }
    }
    return resolved;
  });

  // Multi-bot webhook: each bot runs its own HTTP server, so the OS bind
  // identity is host:port. Require a distinct host:port per webhook bot.
  const seenBinds = new Map<string, string>();
  for (const c of resolvedBots) {
    if (c.transport !== 'webhook') continue;
    const host = c.webhook?.host ?? '127.0.0.1';
    const port = c.webhook?.port ?? 8787;
    const bind = `${host}:${port}`;
    const prev = seenBinds.get(bind);
    if (prev) {
      throw new Error(
        `Bots "${prev}" and "${c.botId}" both bind webhook ${bind}. ` +
        `Each webhook bot needs a distinct host:port (a separate path is not enough — ` +
        `one HTTP server per bot binds the whole port).`,
      );
    }
    seenBinds.set(bind, c.botId ?? '');
  }

  return resolvedBots;
}

/**
 * v1.1: openclaw-style per-bot personality. Read `<botRoot>/SOUL.md` if it
 * exists and return its trimmed contents as the bot's "soul" (voice/stance/
 * boundaries), to be composed into the agent system prompt. Mirrors openclaw's
 * SOUL.md: a file you edit, not a config string. When the file is absent or
 * empty, returns undefined so the caller falls back to the `systemPrompt`
 * config string. Best-effort — a read error never blocks startup.
 */
export function loadSoul(botRoot: string): string | undefined {
  const path = pathJoin(botRoot, 'SOUL.md');
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0 ? content : undefined;
  } catch (err) {
    console.warn(
      `[cc-channel-octo] WARNING: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

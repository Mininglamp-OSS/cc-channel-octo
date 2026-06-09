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
   * DERIVED (not user-configurable): per-bot skills directory,
   * `<baseDir>/<botId>/skills`. Each immediate subdir is a Claude skill
   * (`SKILL.md` + optional `references/`, `scripts/`). Symlinked into each
   * session sandbox's `.claude/skills/` so the SDK discovers it (requires
   * `sdk.settingSources` to include `project`). Per-bot skills override
   * same-named global skills. Populated by `resolveBotConfigs()`.
   */
  skillsDir?: string;
  /**
   * DERIVED (not user-configurable): install-wide skills directory shared by all
   * bots, `<baseDir>/skills`. Loaded for every bot (lower precedence than the
   * per-bot `skillsDir`). Populated by `resolveBotConfigs()`.
   */
  globalSkillsDir?: string;
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
    /**
     * Which filesystem settings sources the SDK loads (`user`/`project`/`local`).
     * Default is `['project']` so the SDK discovers skills symlinked into the
     * session sandbox's `.claude/skills/` (#100 — generic external tooling).
     *
     * Memory isolation is preserved INDEPENDENTLY of this: the auto-memory
     * directory is pinned via inline `settings.autoMemoryDirectory` (the SDK's
     * `flagSettings` tier), which takes precedence over any `projectSettings`
     * value — and the SDK explicitly ignores `autoMemoryDirectory` coming from a
     * checked-in `projectSettings` for security. So `['project']` lets the bot
     * read the sandbox `.claude/` (skills, and any CLAUDE.md/settings.json the
     * agent itself wrote — acceptable, it's the agent's own workspace) WITHOUT
     * the memory leaking into the host `~/.claude` (verified empirically).
     *
     * `'user'` would additionally load the operator's real `~/.claude` config —
     * opt into that deliberately only. Note: this controls what is LOADED (read),
     * not tool-write scope (governed by `permissionMode`/`allowedTools`).
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
     * Q1: Override the upstream Claude API endpoint (e.g. self-hosted gateway).
     * Forwarded to the SDK subprocess via the standard `ANTHROPIC_BASE_URL`
     * environment variable.
     */
    anthropicBaseUrl?: string;
    /**
     * #107: extra environment variables injected verbatim into the agent's SDK
     * subprocess (on top of the inherited process.env). Generic and declarative
     * — cc knows nothing about what they mean. Use it to give a bot's skills the
     * env their external CLIs need, e.g. `{ "OCTO_BOT_ID": "<robotId>" }` so a
     * multi-bot deploy's `octo-cli` calls select the right stored profile.
     * Per-bot (set in `<baseDir>/<id>/config.json`).
     */
    env?: Record<string, string>;
    /**
     * #110: which skills this bot enables, selecting a subset of the skills
     * discovered in its session sandbox's `.claude/skills/` (the shared library
     * `<baseDir>/skills` + per-bot `<baseDir>/<id>/skills`, symlinked in by the
     * skill-linker). Names match each SKILL.md `name` / directory name.
     *   - omitted: SDK default (no explicit selection).
     *   - `'all'`: enable every discovered skill.
     *   - `string[]`: enable only the listed skills.
     * This is the per-bot SELECTION layer over the centrally-maintained library:
     * maintain skills once, each bot picks its own subset. Per-bot (set in
     * `<baseDir>/<id>/config.json`).
     */
    skills?: string[] | 'all';
    /**
     * #115: when true, give the agent a `cron` tool set (cron_create / cron_list
     * / cron_delete) to register per-bot scheduled tasks, persisted to
     * `<baseDir>/<botId>/cron.json` and fired by the gateway scheduler through
     * the normal message pipeline (bound to the creating session). Task creation
     * is gated to the bot owner uid (registerBot.owner_uid). Default off. Per-bot.
     */
    cron?: boolean;
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
}

type PartialConfig = {
  botToken?: string;
  apiUrl?: string;
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
      // #100: load project-scope settings so the SDK discovers skills symlinked
      // into the session sandbox's .claude/skills/. Memory stays isolated via the
      // inline settings.autoMemoryDirectory pin (flagSettings > projectSettings).
      settingSources: ['project'],
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
  // Config comes ONLY from config.json (global + per-bot layers) — there is no
  // environment-variable override path (#103). The sole exception that still
  // *reads* the environment lives nowhere here: `sdk.anthropicBaseUrl` is set in
  // config.json and forwarded to the SDK subprocess by agent-bridge.
  const final = mergeConfig(defaults(), fileCfg);

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
 * Throws on missing/duplicate tokens, duplicate ids, invalid id slugs, or unsafe
 * apiUrl (fail fast at boot).
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
    // #100: per-bot skills (<baseDir>/<id>/skills) + install-wide global skills
    // (<baseDir>/skills). Symlinked into each session sandbox by skill-linker.
    const botSkillsDir = pathJoin(botRoot, 'skills');
    const globalSkillsDir = pathJoin(config.baseDir, 'skills');

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
      skillsDir: botSkillsDir,
      globalSkillsDir,
      botBlocklist: perBotFile.botBlocklist ?? bot.botBlocklist ?? config.botBlocklist,
      allowedBotUids: perBotFile.allowedBotUids ?? bot.allowedBotUids ?? config.allowedBotUids,
      mentionFreeGroups:
        perBotFile.mentionFreeGroups ?? bot.mentionFreeGroups ?? config.mentionFreeGroups,
      groupConfigDir: perBotFile.groupConfigDir ?? config.groupConfigDir,
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
    return resolved;
  });

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

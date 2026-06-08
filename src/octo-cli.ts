/**
 * #94: octo-cli profile auto-seeding.
 *
 * When `sdk.octoCli` is enabled, the agent operates the Octo platform by
 * shelling out to the external `octo-cli` binary. octo-cli authenticates from
 * an encrypted, machine-bound credential store (`~/.octo-cli/credentials.enc`),
 * selected at call time by a NON-SECRET robot id (`--bot-id` / `OCTO_BOT_ID`).
 *
 * The gateway already holds both the raw token (`config.botToken`) and the
 * robot id (`gateway.botId`) after registration, so it seeds the profile once
 * at startup — `octo-cli auth login --bot-id <robotId> --with-token`, with the
 * token written to the child's STDIN (never argv, never env, never a log line).
 * The agent then only ever uses the non-secret robot id; the model cannot read
 * the token back (octo-cli masks it everywhere).
 *
 * Re-running login for the same robot id is idempotent (the profile name
 * defaults to the robot id, so it overwrites its own profile). The whole step
 * is best-effort: a missing binary (ENOENT) or a non-zero exit logs a single
 * warning (never the token) and resolves, so it can never block startup.
 */

import { spawn } from 'node:child_process';

/** Name of the octo-cli binary; resolved from PATH. */
const OCTO_CLI_BIN = 'octo-cli';

export interface SeedOctoCliProfileParams {
  /** Octo API base URL (stored in the profile + exported to the agent). */
  apiUrl: string;
  /** Raw bot token (app_ / bf_ prefixed). Transits child stdin only — never argv/env. */
  botToken: string;
  /** The bot's robot id (gateway.botId) — the non-secret `--bot-id` selector. */
  robotId: string;
}

/**
 * Seed (or refresh) the octo-cli encrypted credential profile for this bot.
 *
 * Best-effort: resolves even on failure (logs one token-free warning). Never
 * throws, so callers can `await` it inline during startup without a try/catch.
 */
export async function seedOctoCliProfile(params: SeedOctoCliProfileParams): Promise<void> {
  const { apiUrl, botToken, robotId } = params;
  if (!robotId) {
    console.warn('[cc-channel-octo] octo-cli: no robot id available; skipping profile seed');
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    // --with-token reads the token from stdin (never argv). --bot-id is the
    // non-secret selector; the profile name defaults to it (idempotent
    // re-seed). --api-base-url stores the base URL in the profile so the
    // credential is self-contained even if the env var is absent.
    const child = spawn(
      OCTO_CLI_BIN,
      ['auth', 'login', '--bot-id', robotId, '--with-token', '--api-base-url', apiUrl],
      { env: { ...process.env, OCTO_API_BASE_URL: apiUrl }, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded capture for the failure message. octo-cli masks tokens in its
      // own output, but cap the size regardless so a runaway child can't flood.
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.warn(
          `[cc-channel-octo] octo-cli: binary '${OCTO_CLI_BIN}' not found on PATH; ` +
            'agent octo-cli calls will fail until it is installed ' +
            '(npm i -g @mininglamp-oss/octo-cli)',
        );
      } else {
        console.warn(`[cc-channel-octo] octo-cli: profile seed failed to spawn: ${err.message}`);
      }
      done();
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        console.log(`[cc-channel-octo] octo-cli: profile seeded for robot id ${robotId}`);
      } else {
        // stderr is octo-cli's error envelope (token already masked by the CLI).
        console.warn(
          `[cc-channel-octo] octo-cli: profile seed exited ${code ?? 'null'}` +
            (stderr.trim() ? `: ${stderr.trim()}` : ''),
        );
      }
      done();
    });

    // Hand the token to the child via stdin, then close it. Never logged.
    child.stdin?.end(`${botToken}\n`);
  });
}

/**
 * `configure` subcommand backend: write the LLM gateway URL + API key into the
 * global config's `sdk` block. Daemon-driven one-click install calls
 * `cc-channel-octo configure --gateway-url <url> --api-key <key>`.
 *
 * Independent of loadConfig(): loadConfig requires apiUrl (bot binding comes
 * later via the provision flow), but install must be able to write gateway+key
 * before any bot exists. So this does a raw read-merge-write of the JSON file,
 * touching only sdk.anthropicBaseUrl + sdk.apiKey.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG_PATH } from './config.js'
import { isAllowedApiUrl } from './url-policy.js'

/**
 * The Anthropic SDK appends `/v1/messages` to ANTHROPIC_BASE_URL. A gateway
 * pasted with a trailing `/v1` would otherwise yield `/v1/v1/messages` (404,
 * misreported as a model error). Strip a trailing `/v1` (optionally with a
 * slash) so the stored base is the host root. Pure for unit testing.
 */
export function normalizeGatewayUrl(raw: string): string {
  return raw.replace(/\/v1\/?$/, '')
}

export function configure(
  gatewayUrl: string,
  apiKey: string,
  configPath?: string,
  opts?: { model?: string; apiUrl?: string },
): void {
  if (!gatewayUrl) throw new Error('configure: --gateway-url is required')
  if (!apiKey) throw new Error('configure: --api-key is required')
  // The gateway receives the API key + all prompt/response content, so it gets
  // the same SSRF policy as apiUrl (mirrors loadConfig's anthropicBaseUrl check).
  if (!isAllowedApiUrl(gatewayUrl)) {
    throw new Error(`configure: unsafe --gateway-url ${gatewayUrl} (must be https:// or http://localhost)`)
  }
  // apiUrl is the Octo IM server (cc's top-level config.apiUrl). The daemon
  // passes its server url at install time so the zero-bot idle gateway can boot
  // (loadConfig requires apiUrl). Same SSRF policy as the gateway url.
  if (opts?.apiUrl && !isAllowedApiUrl(opts.apiUrl)) {
    throw new Error(`configure: unsafe --api-url ${opts.apiUrl} (must be https:// or http://localhost)`)
  }
  const normalizedUrl = normalizeGatewayUrl(gatewayUrl)
  const path = configPath ?? DEFAULT_CONFIG_PATH
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      // Validate that the root is a plain object before treating it as one.
      if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed))) {
        throw new Error(`configure: existing config at ${path} is not a JSON object`)
      }
      existing = parsed as Record<string, unknown>
    } catch (err) {
      // Re-throw the clear "not a JSON object" error as-is; wrap parse errors.
      if (err instanceof Error && err.message.includes('is not a JSON object')) {
        throw err
      }
      throw new Error(`configure: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Narrow the existing sdk block to a plain object before merging (the file is
  // untyped JSON; repo lint forbids `any`, so read it as unknown + narrow).
  const existingSdk =
    existing.sdk && typeof existing.sdk === 'object' && !Array.isArray(existing.sdk)
      ? (existing.sdk as Record<string, unknown>)
      : {}
  const merged: Record<string, unknown> = {
    ...existing,
    sdk: { ...existingSdk, anthropicBaseUrl: normalizedUrl, apiKey },
  }
  // Write model only when provided; omitting it PRESERVES any existing sdk.model
  // (the existingSdk spread above) so a re-configure that just rotates the key
  // never wipes the model. Resetting model→default is intentionally not a
  // configure feature (add an explicit --clear-model later if ever needed).
  if (opts?.model) {
    (merged.sdk as Record<string, unknown>).model = opts.model
  }
  // The Octo IM server url lives at the top level (not under sdk).
  if (opts?.apiUrl) {
    merged.apiUrl = opts.apiUrl
  }
  mkdirSync(dirname(path), { recursive: true })

  // Atomic write: temp file in same directory with 0600 mode, then rename.
  // `wx` (exclusive create) refuses to write through a pre-existing file or a
  // symlink prepositioned at the temp path — important for a secret-bearing
  // writer. The pid+timestamp name makes a real collision practically impossible.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(tmpPath, path)
    // Belt-and-suspenders: force 0600 on the final file too.
    chmodSync(path, 0o600)
  } catch (err) {
    // Best-effort cleanup of OUR temp file — but if the failure was EEXIST, the
    // path already existed and is not ours to delete.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        unlinkSync(tmpPath)
      } catch {
        /* already gone or never created — fine */
      }
    }
    throw new Error(`configure: failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

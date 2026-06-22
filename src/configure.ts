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
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG_PATH } from './config.js'
import { isAllowedApiUrl } from './url-policy.js'

export function configure(gatewayUrl: string, apiKey: string, configPath?: string): void {
  if (!gatewayUrl) throw new Error('configure: --gateway-url is required')
  if (!apiKey) throw new Error('configure: --api-key is required')
  // The gateway receives the API key + all prompt/response content, so it gets
  // the same SSRF policy as apiUrl (mirrors loadConfig's anthropicBaseUrl check).
  if (!isAllowedApiUrl(gatewayUrl)) {
    throw new Error(`configure: unsafe --gateway-url ${gatewayUrl} (must be https:// or http://localhost)`)
  }
  const path = configPath ?? DEFAULT_CONFIG_PATH
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    } catch (err) {
      throw new Error(`configure: failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Narrow the existing sdk block to a plain object before merging (the file is
  // untyped JSON; repo lint forbids `any`, so read it as unknown + narrow).
  const existingSdk =
    existing.sdk && typeof existing.sdk === 'object' && !Array.isArray(existing.sdk)
      ? (existing.sdk as Record<string, unknown>)
      : {}
  const merged = {
    ...existing,
    sdk: { ...existingSdk, anthropicBaseUrl: gatewayUrl, apiKey },
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  // writeFileSync mode only applies on create; force 600 on an existing file too.
  chmodSync(path, 0o600)
}

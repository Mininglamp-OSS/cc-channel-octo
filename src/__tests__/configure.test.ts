import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, normalizeGatewayUrl } from '../configure.js'

let dir: string
let cfgPath: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccfg-')); cfgPath = join(dir, 'config.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('configure', () => {
  it('creates a fresh config with sdk gateway + apiKey', () => {
    configure('https://gw.example.com', 'sk-test', cfgPath)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.sdk.anthropicBaseUrl).toBe('https://gw.example.com')
    expect(parsed.sdk.apiKey).toBe('sk-test')
  })
  it('merges into an existing config, preserving other fields', () => {
    writeFileSync(cfgPath, JSON.stringify({ apiUrl: 'https://octo.example.com', sdk: { model: 'claude-x', anthropicBaseUrl: 'https://old' } }))
    configure('https://new-gw', 'sk-new', cfgPath)
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.apiUrl).toBe('https://octo.example.com')
    expect(parsed.sdk.model).toBe('claude-x')
    expect(parsed.sdk.anthropicBaseUrl).toBe('https://new-gw')
    expect(parsed.sdk.apiKey).toBe('sk-new')
  })
  it('writes the file mode 600', () => {
    configure('https://gw', 'sk', cfgPath)
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600)
  })
  it('creates the parent dir if missing', () => {
    const nested = join(dir, 'sub', 'config.json')
    configure('https://gw', 'sk', nested)
    expect(JSON.parse(readFileSync(nested, 'utf-8')).sdk.apiKey).toBe('sk')
  })
  it('throws on empty gatewayUrl or apiKey', () => {
    expect(() => configure('', 'sk', cfgPath)).toThrow()
    expect(() => configure('https://gw', '', cfgPath)).toThrow()
  })
  it('rejects an unsafe (non-http/https) gateway url', () => {
    expect(() => configure('ftp://gw', 'sk', cfgPath)).toThrow()
  })
  it('ensures final file mode is 0600 even when existing file has broader perms', () => {
    // Pre-create config with mode 0644
    writeFileSync(cfgPath, JSON.stringify({ sdk: {} }), { mode: 0o644 })
    configure('https://gw', 'sk-secret', cfgPath)
    const mode = statSync(cfgPath).mode & 0o777
    expect(mode).toBe(0o600)
    const content = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(content.sdk.apiKey).toBe('sk-secret')
  })
  it('throws a clear error when existing config root is not a plain object', () => {
    writeFileSync(cfgPath, JSON.stringify(null))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('throws a clear error when existing config root is an array', () => {
    writeFileSync(cfgPath, JSON.stringify([1, 2, 3]))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('throws a clear error when existing config root is a number', () => {
    writeFileSync(cfgPath, JSON.stringify(42))
    expect(() => configure('https://gw', 'sk', cfgPath)).toThrow(/is not a JSON object/)
  })
  it('strips a trailing /v1 from the stored gateway url', () => {
    configure('https://gw.test/v1', 'sk-test', cfgPath)
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.anthropicBaseUrl).toBe('https://gw.test')
  })
  it('writes sdk.model when a model is provided', () => {
    configure('https://gw.test', 'sk', cfgPath, { model: 'vertexai/claude-opus-4-8' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.model).toBe('vertexai/claude-opus-4-8')
  })
  it('PRESERVES an existing sdk.model when no model is provided', () => {
    writeFileSync(cfgPath, JSON.stringify({ sdk: { model: 'old/model' } }))
    configure('https://gw.test', 'sk', cfgPath) // no model → keep existing
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).sdk.model).toBe('old/model')
  })
  it('writes the top-level apiUrl when provided', () => {
    configure('https://gw.test', 'sk', cfgPath, { apiUrl: 'http://127.0.0.1:8090' })
    expect(JSON.parse(readFileSync(cfgPath, 'utf-8')).apiUrl).toBe('http://127.0.0.1:8090')
  })
  it('rejects an unsafe --api-url', () => {
    expect(() => configure('https://gw.test', 'sk', cfgPath, { apiUrl: 'ftp://evil' })).toThrow()
  })
})

describe('normalizeGatewayUrl', () => {
  it('strips a trailing /v1 or /v1/', () => {
    expect(normalizeGatewayUrl('https://gw.test/v1')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('https://gw.test/v1/')).toBe('https://gw.test')
  })
  it('leaves a bare host or non-version path intact', () => {
    expect(normalizeGatewayUrl('https://gw.test')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('https://gw.test/api')).toBe('https://gw.test/api')
  })
  it('does not strip a mid-path v1', () => {
    expect(normalizeGatewayUrl('https://gw.test/v1/foo')).toBe('https://gw.test/v1/foo')
  })
  it('strips a trailing /v1 case-insensitively and trims surrounding whitespace', () => {
    expect(normalizeGatewayUrl('https://gw.test/V1')).toBe('https://gw.test')
    expect(normalizeGatewayUrl('  https://gw.test/v1/  ')).toBe('https://gw.test')
  })
})

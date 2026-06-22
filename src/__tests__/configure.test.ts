import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from '../configure.js'

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
})

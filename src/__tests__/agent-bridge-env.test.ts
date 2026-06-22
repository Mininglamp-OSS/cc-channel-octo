import { describe, it, expect } from 'vitest'
import { buildSdkEnv } from '../agent-bridge.js'

describe('buildSdkEnv', () => {
  it('injects ANTHROPIC_API_KEY when sdk.apiKey set', () => {
    const env = buildSdkEnv({ apiKey: 'sk-test', anthropicBaseUrl: 'https://gw.example.com' }, { HOME: '/h' })
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.example.com')
    expect(env?.HOME).toBe('/h')
  })
  it('injects ANTHROPIC_BASE_URL only when apiKey absent', () => {
    const env = buildSdkEnv({ anthropicBaseUrl: 'https://gw.example.com' }, { HOME: '/h' })
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.example.com')
    expect(env?.ANTHROPIC_API_KEY).toBeUndefined()
  })
  it('returns undefined when nothing to inject', () => {
    expect(buildSdkEnv({}, { HOME: '/h' })).toBeUndefined()
  })
  it('apiKey alone (no baseUrl) still injects key', () => {
    const env = buildSdkEnv({ apiKey: 'sk-only' }, { HOME: '/h' })
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-only')
  })
})

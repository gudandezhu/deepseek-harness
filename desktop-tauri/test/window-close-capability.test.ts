import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Capability {
  identifier: string
  local?: boolean
  remote?: { urls: string[] }
  windows?: string[]
  webviews?: string[]
  permissions: Array<string | { identifier: string }>
}

const capabilitiesDirectory = new URL('../src-tauri/capabilities/', import.meta.url)
const capabilities = readdirSync(capabilitiesDirectory)
  .filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(new URL(name, capabilitiesDirectory), 'utf8')) as Capability)
const closeCapabilities = capabilities.filter(capability => capability.permissions.some(permission =>
  (typeof permission === 'string' ? permission : permission.identifier) === 'core:window:allow-close',
))

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as {
  app: { security: { capabilities?: Array<string | Capability> } }
}

describe('window close capability', () => {
  it('grants close through exactly one dedicated capability loaded by the real Tauri configuration', () => {
    expect(closeCapabilities.map(capability => capability.identifier)).toEqual(['window-close'])
    const enabled = config.app.security.capabilities
    if (enabled !== undefined)
      expect(enabled).toContain('window-close')
  })

  it('limits close to local attached shell windows without granting it to main or pet', () => {
    const capability = closeCapabilities.find(capability => capability.identifier === 'window-close')
    expect(capability).toMatchObject({
      local: true,
      windows: ['window-*', 'remote-*'],
      permissions: ['core:window:allow-close'],
    })
    expect(capability).not.toHaveProperty('webviews')
  })

  it('does not expose close to loopback iframe origins in any capability', () => {
    for (const capability of closeCapabilities)
      expect(capability, capability.identifier).not.toHaveProperty('remote')
    expect(closeCapabilities).toHaveLength(1)
  })
})

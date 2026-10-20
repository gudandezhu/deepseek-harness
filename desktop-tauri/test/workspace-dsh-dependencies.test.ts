import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const root = new URL('../', import.meta.url)
const packages = readdirSync(new URL('packages/', root), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
  .map(entry => new URL(`packages/${entry.name}/package.json`, root))
  .filter(file => existsSync(file))

function readManifest(file: URL): Manifest {
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest
}

describe('workspace DSH development dependency ownership', () => {
  it('pins every Harness development catalog entry to rc.2 without retaining rc.1 resolutions', () => {
    const manifest = readManifest(new URL('package.json', root))
    const names = Object.keys(manifest.devDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-')).sort()
    expect(names).toHaveLength(32)
    const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')
    const catalog = workspace.match(/^ {2}dsh:\r?\n([\s\S]*?)(?=^ {2}\w+:)/m)?.[1]
    expect(catalog).toBeTypeOf('string')
    const entries = [...catalog!.matchAll(/^ {4}'(@deepseek-ai\/dsh-[^']+)': ([^\r\n]+)$/gm)]
      .map(([, name, version]) => [name, version])
    expect(Object.fromEntries(entries)).toEqual(Object.fromEntries(names.map(name => [name, '0.2.1-rc.2'])))
    const lockfile = readFileSync(new URL('pnpm-lock.yaml', root), 'utf8')
    expect(lockfile).not.toContain('0.2.1-rc.1')
    for (const name of names)
      expect(lockfile).toContain(`'${name}':\n      specifier: 0.2.1-rc.2\n      version: 0.2.1-rc.2`)
  })

  it('keeps Zod development-only at the root rather than shipping a second runtime copy', () => {
    expect(readManifest(new URL('package.json', root)).devDependencies?.zod).toBe('catalog:utils')
    for (const file of packages) {
      expect(readManifest(file).dependencies?.zod, file.pathname).toBeUndefined()
      expect(readManifest(file).devDependencies?.zod, file.pathname).toBeUndefined()
    }
  })

  it('keeps every child package free of @deepseek-ai development dependencies', () => {
    expect(packages.length).toBeGreaterThan(0)
    for (const file of packages) {
      const scoped = Object.keys(readManifest(file).devDependencies ?? {})
        .filter(name => name.startsWith('@deepseek-ai/'))
      expect(scoped, file.pathname).toEqual([])
    }
  })

  it('retains the migrated development dependency union at the root with unchanged catalog versions', () => {
    const manifest = readManifest(new URL('package.json', root))
    for (const name of [
      'cordis',
      'cordis-plugin-loader',
      'dsh-agent',
      'dsh-agent-preset-registry',
      'dsh-api-session-controller',
      'dsh-api-workspace-controller',
      'dsh-client-connection',
      'dsh-client-locale',
      'dsh-client-store',
      'dsh-client-ui-conversation',
      'dsh-client-ui-layout',
      'dsh-client-ui-primitives',
      'dsh-client-ui-renderer',
      'dsh-client-ui-session',
      'dsh-client-ui-settings',
      'dsh-client-ui-slots',
      'dsh-client-ui-workspace',
      'dsh-llm',
      'dsh-session',
      'dsh-session-persistence',
      'dsh-session-projection',
      'dsh-skill-filesystem',
      'dsh-tools',
      'dsh-user-approval',
      'dsh-user-questions',
      'dsh-util-values',
      'dsh-workspace',
    ]) {
      expect(manifest.devDependencies?.[`@deepseek-ai/${name}`], name).toBe('catalog:dsh')
    }
  })
})

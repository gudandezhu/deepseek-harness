import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE_MANIFEST = new URL('../packages/dsh-tauri-bundle/package.json', import.meta.url)
const RESOURCE_NODE_MODULES = new URL('../src-tauri/resources/node_modules/', import.meta.url)
const DSH_STATIC_IMPORT = /\b(?:from|import)\s*['"]@deepseek-ai\/[^'"]+['"]|\brequire\s*\(\s*['"]@deepseek-ai\/[^'"]+['"]\s*\)/

const BUILT = existsSync(fileURLToPath(RESOURCE_NODE_MODULES))

interface PluginManifest {
  name?: unknown
  dependencies?: Record<string, unknown>
  dsh?: unknown
  main?: unknown
}

function readJson(url: URL | string): PluginManifest {
  return JSON.parse(readFileSync(url, 'utf8')) as PluginManifest
}

function bundledPluginNames(): string[] {
  return Object.keys(readJson(BUNDLE_MANIFEST).dependencies ?? {})
}

function packageJsonFiles(root: URL): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === 'package.json')
      files.push(join(entry.parentPath, entry.name))
  }
  return files
}

describe.skipIf(!BUILT)('bundled plugin resource closure', () => {
  it('contains every bundled plugin with a valid entry', () => {
    for (const name of bundledPluginNames()) {
      const manifestUrl = new URL(`../src-tauri/resources/node_modules/${name}/package.json`, import.meta.url)
      expect(() => readJson(manifestUrl)).not.toThrow()
      const manifest = readJson(manifestUrl)
      expect(typeof manifest.dsh === 'object' && manifest.dsh !== null && !Array.isArray(manifest.dsh)).toBe(true)
      if (typeof manifest.main === 'string')
        expect(statSync(new URL(`../src-tauri/resources/node_modules/${name}/${manifest.main}`, import.meta.url)).isFile()).toBe(true)
    }
  })

  it('does not ship build tools or runtime-owned Zod in any nested package', () => {
    const excludedPackages = packageJsonFiles(RESOURCE_NODE_MODULES)
      .filter(file => ['date-fns', 'typescript', '@genapi/shared', 'zod'].includes(String(readJson(pathToFileURL(file)).name)))

    expect(excludedPackages).toEqual([])
  })

  it('keeps DSH-owned host modules loader-resolved', () => {
    for (const name of bundledPluginNames()) {
      const manifestUrl = new URL(`../src-tauri/resources/node_modules/${name}/package.json`, import.meta.url)
      const manifest = readJson(manifestUrl)
      if (typeof manifest.main !== 'string')
        continue

      const entryUrl = new URL(`../src-tauri/resources/node_modules/${name}/${manifest.main}`, import.meta.url)
      expect(statSync(entryUrl).isFile()).toBe(true)
      expect(readFileSync(entryUrl, 'utf8')).not.toMatch(DSH_STATIC_IMPORT)
    }
  })
})

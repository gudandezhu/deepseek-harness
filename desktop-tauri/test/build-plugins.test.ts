import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isNonRuntimeFile, pruneDeployment, relativeSpecifiers } from '../scripts/build-plugins'

const scratchRoot = resolve('.temp', 'build-plugins-test')
const scratch: string[] = []

afterEach(() => {
  for (const root of scratch.splice(0)) {
    if (dirname(root) !== scratchRoot) {
      throw new Error(`UNSAFE_TEST_CLEANUP: ${root}`)
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function deploymentFixture(): string {
  mkdirSync(scratchRoot, { recursive: true })
  const container = mkdtempSync(join(scratchRoot, 'deployment-'))
  scratch.push(container)
  const root = join(container, 'node_modules')
  const manifests = {
    'plugin': { main: './index.js', dependencies: { 'dsh-h3': '0.2.1' } },
    'dsh-h3': {
      name: 'dsh-h3',
      exports: { '.': './dist/index.mjs', './utils': './dist/utils.mjs', './genapi': './dist/genapi.mjs', './package.json': './package.json' },
      dependencies: { h3: '2.0.1' },
      peerDependencies: { 'typescript': '^5.8.3', '@genapi/shared': '^4.1.4' },
      peerDependenciesMeta: { 'typescript': { optional: true }, '@genapi/shared': { optional: true } },
    },
    'h3': { main: './index.js' },
    'typescript': { main: './index.js' },
    '@genapi/shared': { main: './index.js' },
  }
  for (const [name, manifest] of Object.entries(manifests)) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'LICENSE'), 'fixture attribution')
  }
  const dist = join(root, 'dsh-h3', 'dist')
  mkdirSync(dist)
  writeFileSync(join(dist, 'index.mjs'), 'import "h3"; export const server = true')
  writeFileSync(join(dist, 'utils.mjs'), 'export const context = true')
  writeFileSync(join(dist, 'genapi.mjs'), 'import ts from "typescript"; export { ts }')
  writeFileSync(join(root, 'plugin', 'index.js'), 'import "dsh-h3"; import "dsh-h3/utils"')
  return root
}

describe('plugin deployment build-tool pruning', () => {
  it('removes only the generator export and orphan peers while retaining runtime entries and licenses', async () => {
    const root = deploymentFixture()
    pruneDeployment(root, ['plugin'])
    const manifest = JSON.parse(readFileSync(join(root, 'dsh-h3', 'package.json'), 'utf8'))
    expect(manifest.exports).toEqual({ '.': './dist/index.mjs', './utils': './dist/utils.mjs', './package.json': './package.json' })
    expect(manifest.peerDependencies).toEqual({})
    expect(manifest.peerDependenciesMeta).toEqual({})
    expect(existsSync(join(root, 'dsh-h3', 'dist', 'genapi.mjs'))).toBe(false)
    expect(existsSync(join(root, 'typescript'))).toBe(false)
    expect(existsSync(join(root, '@genapi', 'shared'))).toBe(false)
    expect(readFileSync(join(root, 'dsh-h3', 'dist', 'index.mjs'), 'utf8')).toBe('import "h3"; export const server = true')
    expect(readFileSync(join(root, 'dsh-h3', 'dist', 'utils.mjs'), 'utf8')).toBe('export const context = true')
    expect(readFileSync(join(root, 'dsh-h3', 'LICENSE'), 'utf8')).toBe('fixture attribution')
    const require = createRequire(join(root, 'plugin', 'index.js'))
    expect(require.resolve('dsh-h3')).toBe(join(root, 'dsh-h3', 'dist', 'index.mjs'))
    expect(require.resolve('dsh-h3/utils')).toBe(join(root, 'dsh-h3', 'dist', 'utils.mjs'))
    expect(() => require.resolve('dsh-h3/genapi')).toThrow('Package subpath \'./genapi\' is not defined by "exports"')
    expect(await import(pathToFileURL(require.resolve('dsh-h3')).href)).toMatchObject({ server: true })
    expect(await import(pathToFileURL(require.resolve('dsh-h3/utils')).href)).toMatchObject({ context: true })
  })

  it('does not apply the generator policy to a scoped lookalike package', () => {
    const root = deploymentFixture()
    const dir = join(root, '@other', 'dsh-h3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@other/dsh-h3', main: './index.js' }))
    writeFileSync(join(dir, 'index.js'), 'export const value = 42')
    writeFileSync(join(root, 'plugin', 'package.json'), JSON.stringify({ dependencies: { 'dsh-h3': '0.2.1', '@other/dsh-h3': '1.0.0' } }))
    pruneDeployment(root, ['plugin'])
    expect(readFileSync(join(dir, 'index.js'), 'utf8')).toBe('export const value = 42')
  })

  it.each(['dependencies', 'peerDependencies', 'optionalDependencies'])('retains TypeScript declared by another package through %s', (field) => {
    const root = deploymentFixture()
    writeFileSync(join(root, 'plugin', 'package.json'), JSON.stringify({
      main: './index.js',
      dependencies: { 'dsh-h3': '0.2.1' },
      [field]: { 'dsh-h3': '0.2.1', 'typescript': '^5.8.3' },
      peerDependenciesMeta: { typescript: { optional: true } },
    }))
    pruneDeployment(root, ['plugin'])
    expect(readFileSync(join(root, 'typescript', 'LICENSE'), 'utf8')).toBe('fixture attribution')
    expect(existsSync(join(root, '@genapi', 'shared'))).toBe(false)
  })

  it.each([
    ['index.mjs', 'import "typescript"'],
    ['shared.cjs', 'require("typescript/lib/typescript.js")'],
    ['shared.js', 'export * from "@genapi/shared"'],
    ['shared.mjs', 'import(`@genapi/shared/subpath`)'],
  ])('rejects a runtime reference to a generator peer in %s', (file, source) => {
    const root = deploymentFixture()
    writeFileSync(join(root, 'dsh-h3', 'dist', file), source)
    expect(() => pruneDeployment(root, ['plugin'])).toThrow('PLUGIN_DEPLOY_BUILD_TOOL_REQUIRED:')
  })

  it.each(['dsh-h3/genapi', 'dsh-h3/genapi/subpath'])('rejects a plugin importing %s', (specifier) => {
    const root = deploymentFixture()
    writeFileSync(join(root, 'plugin', 'index.js'), `import "${specifier}"`)
    expect(() => pruneDeployment(root, ['plugin'])).toThrow('PLUGIN_DEPLOY_BUILD_TOOL_REQUIRED:')
  })

  it('rejects an undeclared generator peer imported by another surviving package', () => {
    const root = deploymentFixture()
    writeFileSync(join(root, 'plugin', 'index.js'), 'import "typescript"')
    expect(() => pruneDeployment(root, ['plugin'])).toThrow('PLUGIN_DEPLOY_DEPENDENCY_MISSING:')
  })

  it('rejects a runtime entry importing the generator by relative path', () => {
    const root = deploymentFixture()
    writeFileSync(join(root, 'dsh-h3', 'dist', 'index.mjs'), 'import "./genapi.mjs"')
    expect(() => pruneDeployment(root, ['plugin'])).toThrow('PLUGIN_DEPLOY_RELATIVE_MISSING:')
  })

  it.each(['required-peer', 'regular-dependency', 'optional-dependency', 'changed-export', 'missing-tool'])('rejects upstream changes to the generator contract: %s', (change) => {
    const root = deploymentFixture()
    const file = join(root, 'dsh-h3', 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    if (change === 'required-peer')
      manifest.peerDependenciesMeta.typescript.optional = false
    if (change === 'regular-dependency')
      manifest.dependencies.typescript = '^5.8.3'
    if (change === 'optional-dependency')
      manifest.optionalDependencies = { typescript: '^5.8.3' }
    if (change === 'changed-export')
      manifest.exports['./genapi'] = { import: './dist/genapi.mjs' }
    if (change === 'missing-tool')
      rmSync(join(root, 'dsh-h3', 'dist', 'genapi.mjs'))
    writeFileSync(file, JSON.stringify(manifest))
    expect(() => pruneDeployment(root, ['plugin'])).toThrow('PLUGIN_DEPLOY_BUILD_TOOL_CONTRACT:')
  })
})

describe('plugin deployment relative dependencies', () => {
  it('collects static imports and re-exports including side effects', () => {
    expect(relativeSpecifiers(`
      import value from './value.js'
      import './setup.js'
      export { value } from '../shared.js'
      export * from './exports.js'
      import React from 'react'
    `)).toEqual(['./value.js', './setup.js', '../shared.js', './exports.js'])
  })

  it('collects literal require and dynamic import targets', () => {
    expect(relativeSpecifiers(`
      const value = require('./value.cjs')
      const lazy = () => import('../lazy.mjs')
      const template = import(\`./template.js\`)
      require('node:fs')
      import('./dynamic/' + name)
    `)).toEqual(['./value.cjs', '../lazy.mjs', './template.js'])
  })

  it('ignores example code in strings, templates, comments and regular expressions', () => {
    expect(relativeSpecifiers(`
      console.error("const MyComponent = lazy(() => import('./MyComponent'))")
      const quoted = 'require("./quoted")'
      const template = \`export { example } from './template'\`
      // import './comment'
      /* require('./block-comment') */
      const pattern = /require('..')/
      client.require('./method')
      client.from('./other-method')
    `)).toEqual([])
  })

  it('retains real imports inside template substitutions', () => {
    expect(relativeSpecifiers(`const text = \`example \${require('./real.cjs')}\``)).toEqual(['./real.cjs'])
  })

  it.each(['react.development.js', 'react.react-server.development.js'])('does not treat %s diagnostics as missing modules', (file) => {
    const require = createRequire(import.meta.url)
    const root = dirname(require.resolve('react/package.json'))
    const source = readFileSync(join(root, 'cjs', file), 'utf8')
    expect(source).toContain('import(\'./MyComponent\')')
    expect(relativeSpecifiers(source)).not.toContain('./MyComponent')
  })
})

describe('plugin deployment documentation pruning', () => {
  it('prunes documentation, sourcemaps and type declarations', () => {
    expect(isNonRuntimeFile(join('pkg', 'README.md'))).toBe(true)
    expect(isNonRuntimeFile(join('pkg', 'CHANGELOG.md'))).toBe(true)
    expect(isNonRuntimeFile(join('pkg', 'dist', 'index.js.map'))).toBe(true)
    expect(isNonRuntimeFile(join('pkg', 'dist', 'index.d.ts'))).toBe(true)
  })

  it('keeps attribution files and runtime code', () => {
    expect(isNonRuntimeFile(join('pkg', 'LICENSE'))).toBe(false)
    expect(isNonRuntimeFile(join('pkg', 'NOTICE.md'))).toBe(false)
    expect(isNonRuntimeFile(join('pkg', 'dist', 'index.js'))).toBe(false)
  })

  it('keeps skills packaged with a plugin for the skill provider to scan', () => {
    expect(isNonRuntimeFile(join('dsh-tauri-pet', 'skills', 'hatch-dsh-pet', 'SKILL.md'))).toBe(false)
    expect(isNonRuntimeFile(join('dsh-tauri-pet', 'skills', 'hatch-dsh-pet', 'README.md'))).toBe(false)
    expect(isNonRuntimeFile(join('dsh-tauri-pet', 'skills', 'hatch-dsh-pet', 'references', 'sprite-atlas.md'))).toBe(false)
    expect(isNonRuntimeFile(join('dsh-tauri-extension', 'skills', 'skill-creator', 'SKILL.md'))).toBe(false)
    expect(isNonRuntimeFile(join('dsh-tauri-extension', 'skills', 'skill-creator', 'agents', 'grader.md'))).toBe(false)
    expect(isNonRuntimeFile(join('dsh-tauri-extension', 'skills', 'find-skills', 'LICENSE'))).toBe(false)
  })

  it('does not treat a lookalike segment as a skills directory', () => {
    expect(isNonRuntimeFile(join('pkg', 'skills-extra', 'GUIDE.md'))).toBe(true)
  })
})

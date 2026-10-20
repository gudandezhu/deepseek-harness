import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDesktopArtifactsCurrent, assertPluginArtifactsCurrent } from './artifacts'

let root: string
const SOURCE_TIME = 1_700_000_000
const BUILD_TIME = SOURCE_TIME + 10

function file(path: string, content = '', time = SOURCE_TIME): string {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  utimesSync(target, time, time)
  return target
}

function plugin(name = 'fixture', client: string | { default: string } = './dist/client.js'): void {
  file(`packages/${name}/package.json`, JSON.stringify({ main: './dist/index.js', exports: { './client': client } }))
  file(`packages/${name}/src/index.ts`, 'export default {}')
  file(`packages/${name}/dist/index.js`, '', BUILD_TIME)
  file(`packages/${name}/dist/client.js`, '', BUILD_TIME)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-e2e-artifacts-test-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('真实集成产物门禁', () => {
  it.each(['./dist/client.js', { default: './dist/client.js' }])('接受两种真实 client 导出形态且只比较文件元数据：%j', (client) => {
    plugin('fixture', client)
    expect(() => assertPluginArtifactsCurrent(root, 'fixture'), '新产物必须能进入真实集成').not.toThrow()
  })

  it.each(['dist/index.js', 'dist/client.js'])('缺少任一运行入口必须失败：%s', (entry) => {
    plugin()
    rmSync(join(root, 'packages/fixture', entry))
    expect(() => assertPluginArtifactsCurrent(root, 'fixture'), '缺构建不得跳过或降级到源码').toThrow('尚未构建')
  })

  it.each([
    'packages/fixture/src/index.ts',
    'packages/fixture/scripts/styles.ts',
    'packages/fixture/tsdown.config.ts',
    'packages/fixture/package.json',
    'packages/dsh-tauri-tsdown/src/index.ts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tailwind.plugins.config.js',
  ])('任一输入晚于产物时禁止旧 L2 假绿：%s', (input) => {
    plugin()
    if (input.endsWith('package.json') && input.startsWith('packages/fixture/'))
      utimesSync(join(root, input), BUILD_TIME + 1, BUILD_TIME + 1)
    else
      file(input, '', BUILD_TIME + 1)
    expect(() => assertPluginArtifactsCurrent(root, 'fixture'), '源文件或构建依赖变动必须阻断旧产物').toThrow('构建产物已过期')
  })

  it('宿主新而 client 旧仍必须拒绝，不能只看最新入口', () => {
    plugin()
    file('packages/fixture/src/index.ts', '', BUILD_TIME + 1)
    file('packages/fixture/dist/index.js', '', BUILD_TIME + 2)
    expect(() => assertPluginArtifactsCurrent(root, 'fixture'), '旧 client 不得被新宿主入口掩盖').toThrow('构建产物已过期')
  })

  it('测试文件不作为构建输入', () => {
    plugin()
    file('packages/fixture/src/index.test.ts', '', BUILD_TIME + 1)
    file('packages/fixture/test/helper.ts', '', BUILD_TIME + 1)
    expect(() => assertPluginArtifactsCurrent(root, 'fixture'), '仅测试变动不应强制插件构建').not.toThrow()
  })

  it('忽略构建后回写的生成样式，但仍校验原 CSS 输入', () => {
    plugin('dsh-tauri-ui')
    file('packages/dsh-tauri-ui/src/client/styles/index.ts', '', BUILD_TIME + 1)
    expect(() => assertPluginArtifactsCurrent(root, 'dsh-tauri-ui'), '生成器构建后回写不得误报').not.toThrow()
    file('packages/dsh-tauri-ui/src/client/styles/index.css', '', BUILD_TIME + 1)
    expect(() => assertPluginArtifactsCurrent(root, 'dsh-tauri-ui'), '原始样式晚于 bundle 必须失败').toThrow('构建产物已过期')
  })

  it.each(['native', 'frontend'])('桌面缺少产物直接失败：%s', (missing) => {
    const binary = join(root, 'desktop.exe')
    if (missing !== 'native')
      file('desktop.exe', '', BUILD_TIME)
    if (missing !== 'frontend')
      file('dist/index.html', '', BUILD_TIME)
    expect(() => assertDesktopArtifactsCurrent(root, binary), '缺原生或前端产物不得启动桌面').toThrow('缺少构建产物')
  })

  it.each(['src-tauri/src/lib.rs', 'src-tauri/resources/manifest.jsonc', 'src/index.tsx', 'pnpm-lock.yaml'])('桌面任一层输入过期均失败：%s', (input) => {
    const binary = file('desktop.exe', '', BUILD_TIME)
    file('dist/index.html', '', BUILD_TIME)
    file(input, '', BUILD_TIME + 1)
    expect(() => assertDesktopArtifactsCurrent(root, binary), '旧原生隔离钩子或旧前端都不得启动').toThrow('构建产物已过期')
  })

  it('只重建前端但未重建内嵌前端的原生二进制时必须失败', () => {
    const binary = file('desktop.exe', '', BUILD_TIME)
    file('src/index.tsx', '', BUILD_TIME + 1)
    file('dist/index.html', '', BUILD_TIME + 2)
    expect(() => assertDesktopArtifactsCurrent(root, binary), '新前端不能证明旧二进制已包含当前前端').toThrow('构建产物已过期')
  })

  it('桌面两层产物均新时才放行', () => {
    const binary = file('desktop.exe', '', BUILD_TIME)
    file('dist/index.html', '', BUILD_TIME)
    file('src-tauri/src/lib.rs')
    file('src/index.tsx')
    expect(() => assertDesktopArtifactsCurrent(root, binary), '完整新产物必须放行').not.toThrow()
  })
})

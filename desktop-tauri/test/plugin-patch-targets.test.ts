import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readSource } from './setup/read-source'

const OFFICIAL_ROW_TARGETS = [
  'dsh-tauri → ui-sidebar-browser',
  'dsh-tauri-model → ui-settings-models',
  'dsh-tauri-scheduler → schedule',
  'dsh-tauri-scheduler → ui-schedule',
]

const PACKAGES_ROOT = new URL('../packages/', import.meta.url)

function readPatchLayer(pkg: string): string {
  return readSource(`packages/${pkg}/cordis.patch.yml`)
}

function packageNames(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(new URL(`${entry.name}/cordis.patch.yml`, PACKAGES_ROOT)))
    .map(entry => entry.name)
    .sort()
}

/** 顶层 `- id:` 才是 patch 目标；`insert:` 内缩进的 `id` 是插入的插件自身条目。 */
function patchTargetIds(source: string): string[] {
  return source.split('\n').flatMap((line) => {
    const match = /^- id: (\S+)\s*$/.exec(line)
    return match === null ? [] : [match[1]]
  })
}

describe('插件 patch 层的官方目标', () => {
  it('桌面桥接 bundle 在原生浏览器未适配前禁用官方侧栏浏览器', () => {
    expect(readPatchLayer('dsh-tauri')).toMatch(/^- id: ui-sidebar-browser\r?\n {2}disabled: true$/m)
  })

  it('定时任务插件明确禁用完整官方调度栈且插入唯一实现', () => {
    const source = readPatchLayer('dsh-tauri-scheduler')
    expect(source).toMatch(/^- id: schedule\r?\n {2}disabled: true$/m)
    expect(source).toMatch(/^- id: ui-schedule\r?\n {2}disabled: true$/m)
    expect(source.match(/name: dsh-tauri-scheduler/g)).toHaveLength(1)
  })

  it('只把核心仍在提供的官方入口列为 patch 目标', () => {
    const actual = packageNames().flatMap(pkg => patchTargetIds(readPatchLayer(pkg)).map(id => `${pkg} → ${id}`))

    expect(actual).toEqual(OFFICIAL_ROW_TARGETS)
  })

  it('dsh-tauri-archive 的 patch 层只插入插件自身', () => {
    const source = readPatchLayer('dsh-tauri-archive')

    expect(patchTargetIds(source)).toEqual([])
    expect(source).toContain('- insert:')
    expect(source).toContain('- id: dsh-tauri-archive')
    expect(source).toContain('name: dsh-tauri-archive')
  })

  it('dsh-tauri-archive 的第三方声明不再声称禁用了官方入口', () => {
    const notices = readSource('packages/dsh-tauri-archive/THIRD_PARTY_NOTICES.md')

    expect(notices).not.toContain('ui-settings-unarchive-sessions')
    expect(notices).not.toContain('Official row disabled')
  })
})

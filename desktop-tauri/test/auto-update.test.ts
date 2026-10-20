import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

/**
 * 「自动更新」开关的接线契约（issue #1132）：用户关闭后不得再静默下载、
 * 也不得在退出时被替换安装。任何一环漏接都会让开关变成装饰。
 */
describe('automatic update opt-out contract', () => {
  it('persists auto_update in the native setting with a backward-compatible default', () => {
    const source = read('src-tauri/src/config/setting.rs')

    expect(source).toContain('pub auto_update: bool')
    expect(source).toContain('#[serde(default = "default_auto_update")]')
    expect(source).toContain('fn default_auto_update() -> bool {')
    // 默认必须是开启：老 store 缺字段时不能被静默关掉既有的自更新行为
    expect(source).toMatch(/fn default_auto_update\(\) -> bool \{\s*true\s*\}/)
    // 整对象写入（旧调用方）不得覆盖精确设置路径写下的开关
    expect(source).toContain('replacement.auto_update = current.auto_update;')
  })

  it('writes the switch through the native config command', () => {
    const source = read('src-tauri/src/bridge/config.rs')

    expect(source).toContain('auto_update: Option<bool>')
    expect(source).toContain('setting.auto_update = auto_update;')
  })

  it('never hands the pending installer over on exit while automatic updates are off', () => {
    const source = read('src-tauri/src/service/update/pending.rs')

    expect(source).toContain('super::auto_update_enabled(app_handle)')
  })

  it('drops the pending installer as soon as the switch is turned off', () => {
    const bridge = read('src-tauri/src/bridge/config.rs')
    const update = read('src-tauri/src/service/update/mod.rs')

    expect(update).toContain('pub fn clear_pending_installer')
    expect(bridge).toContain('if auto_update == Some(false)')
    expect(bridge).toContain('update::clear_pending_installer(&app_handle)')
  })

  it('suppresses the silent download no matter who asks for a check', () => {
    const source = read('src/store/modules/desktop-updater/store.ts')

    // 手动「检查更新」也走 check()：开关关闭后只展示对话框，下载留给「立即更新」
    expect(source).toContain('if (setting.auto_update)')
    expect(source).toContain('void this.download()')
  })

  it('stops polling and silent downloads until the switch is on and settings are hydrated', () => {
    const source = read('src/layout/index.tsx')

    expect(source).toContain('store.setting.hydrated')
    expect(source).toContain('store.setting.auto_update')
    expect(source).toContain('void store.desktopUpdater.check()')
  })
})

import { readFileSync } from 'node:fs'
import i18next from 'i18next'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resources } from '../src/i18n/index.resource'
import {
  containsPatchEntryUnresolved,
  containsPatchLayerEncodingError,
  containsPatchLayerParseError,
  containsQuarantineFailure,
  PATCH_ENTRY_UNRESOLVED_CODE,
  patchEntryUnresolvedEntries,
  patchLayerErrorDetail,
  quarantineFailureDetail,
} from '../src/store/modules/harness/patch-layer'

const eventListeners = new Map<string, (event: unknown) => void>()
const invoke = vi.fn()
const toast = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, callback: (payload: unknown) => void) => {
    eventListeners.set(event, callback)
    return vi.fn()
  }),
}))
vi.mock('@/utils/toast', () => ({ toast }))
vi.mock('@/config/client', () => ({ queryClient: { invalidateQueries: vi.fn() } }))
vi.mock('@/store', async () => ({ store: { harness: (await import('../src/store/modules/harness')).harness } }))
vi.mock('../src/store/modules/harness-updater', () => ({
  harnessUpdater: { checkForUpdate: vi.fn() },
}))

// 必须在 mock 工厂所需的变量初始化之后再取用 store（vi.mock 会被提升到文件顶部）。
const { harness } = await import('../src/store/modules/harness')
const { attachStartupDiagnostics } = await import('../src/store/modules/harness/utils')
const { Setup } = await import('../src/layout/components/setup')

beforeAll(async () => {
  await i18next.init({ resources, lng: 'zh-CN', interpolation: { escapeValue: false }, keySeparator: false, nsSeparator: false, initAsync: false })
})

beforeEach(async () => {
  await i18next.changeLanguage('zh-CN')
  eventListeners.clear()
  invoke.mockReset()
  toast.mockReset()
  invoke.mockImplementation(async (command: string) => {
    switch (command) {
      case 'get_runtime_info': return { service_url: 'http://127.0.0.1:31415' }
      case 'runtime_ready': return true
      case 'proxy_health_check': return 'Healthy'
      case 'get_preinstall_pending': return false
      case 'get_profiles': return [{ id: 'tauri', active: true }]
      case 'get_app_config': return { installed: true }
      case 'read_service_logs': return ''
      case 'ensure_internal_plugins':
      case 'launch_harness':
      case 'harness_ownership':
      case 'shutdown_harness': return undefined
      default: throw new Error(`Unexpected command: ${command}`)
    }
  })
  Object.assign(harness, {
    status: 'ready',
    errorMsg: '',
    errorLogs: [],
    patchLayerHint: '',
    serviceHealthy: false,
    serviceRunning: false,
    iframeAliveKey: harness.iframeKey,
    busyAction: null,
  })
})

afterEach(() => {
  harness.serviceHealthy = false
  harness.serviceRunning = false
  vi.restoreAllMocks()
})

/**
 * issue #525：用户手写的 `cordis.patch.yml` 解析失败时，启动失败信息里的真实
 * 原因被包在「Plugin installation 阶段失败」里，前端必须能识别出来并给出
 * 「哪个文件、哪一行、怎么改」的提示与隔离入口。
 */
const REAL_FAILURE = 'Harness 在Plugin installation阶段失败。最后的就绪状态：'
  + 'INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_PATCH_PARSE_FAILED: '
  + 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: '
  + 'mapping values are not allowed in this context at line 15 column 155'

describe('patch layer diagnostics', () => {
  it('recognizes a wrapped patch parse failure', () => {
    expect(containsPatchLayerParseError(REAL_FAILURE)).toBe(true)
  })

  it('ignores unrelated startup failures', () => {
    expect(containsPatchLayerParseError('Harness 在process-boot阶段失败')).toBe(false)
    // 只是提到错误码（例如日志行）但没有 `:` 分隔的细节时不算命中。
    expect(containsPatchLayerParseError('see INTERNAL_PLUGIN_PATCH_PARSE_FAILED for details')).toBe(false)
  })

  it('extracts the file path and YAML error with line and column', () => {
    expect(patchLayerErrorDetail(REAL_FAILURE)).toBe(
      'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: '
      + 'mapping values are not allowed in this context at line 15 column 155',
    )
  })

  it('returns an empty detail when the code is absent', () => {
    expect(patchLayerErrorDetail('Harness 在plugin-install阶段失败')).toBe('')
  })
})

/**
 * 隔离失败（改名被占用 / 权限拒绝）：后端拒绝切档案与重启并回
 * `PATCH_LAYER_QUARANTINE_FAILED`，前端必须据此换成「先处理文件」的提示，
 * 而不是假装已恢复。
 */
const QUARANTINE_FAILURE = 'PATCH_LAYER_QUARANTINE_FAILED: '
  + 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: Access is denied. (os error 5)'

describe('patch layer encoding recovery', () => {
  it('recognizes wrapped encoding failures without treating IO errors as damaged patches', () => {
    expect(containsPatchLayerEncodingError('INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_PATCH_ENCODING_FAILED: /tmp/cordis.patch.yml: invalid UTF-8')).toBe(true)
    expect(containsPatchLayerEncodingError('INTERNAL_PLUGIN_PATCH_READ_FAILED: /tmp/cordis.patch.yml: Permission denied')).toBe(false)
    expect(containsPatchLayerEncodingError('see INTERNAL_PLUGIN_PATCH_ENCODING_FAILED for details')).toBe(false)
    expect(containsPatchLayerEncodingError(REAL_FAILURE)).toBe(false)
  })

  it.each(['profiles\\tauri\\cordis.patch.yml', 'cordis.patch.yml'])('shows a UTF-8 hint and quarantine button for %s', async (layer) => {
    const detail = `C:\\Users\\26231\\.dsh\\${layer}: stream did not contain valid UTF-8`
    const message = `Harness 在Plugin installation阶段失败。最后的就绪状态：INTERNAL_PLUGIN_PATCH_ENCODING_FAILED: ${detail}`
    invoke.mockResolvedValue('')

    const diagnosed = await attachStartupDiagnostics(message)
    expect(diagnosed.message).toBe(message)
    expect(diagnosed.patchLayerHint).toContain(detail)
    expect(diagnosed.patchLayerHint).toContain('另存为 UTF-8')
    expect(diagnosed.patchLayerHint).toContain('.broken-')
    expect(diagnosed.patchLayerHint).toContain('不会自动转码')
    expect(diagnosed.patchLayerHint).not.toContain('YAML 语法错误')
    expect(patchLayerErrorDetail(message)).toBe(detail)

    Object.assign(harness, { status: 'error', errorMsg: message, patchLayerHint: diagnosed.patchLayerHint })
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18next }, createElement(Setup)))
    expect(html).toContain('另存为 UTF-8')
    expect(html).toContain('隔离损坏的补丁文件</button>')
    expect(html).not.toContain('移除悬空条目</button>')
  })

  it('does not offer destructive encoding recovery for an IO read failure', async () => {
    const message = 'INTERNAL_PLUGIN_PATCH_READ_FAILED: C:/data/cordis.patch.yml: Access is denied. (os error 5)'
    invoke.mockResolvedValue('')
    const diagnosed = await attachStartupDiagnostics(message)
    expect(diagnosed.patchLayerHint).toBeUndefined()
    expect(patchLayerErrorDetail(message)).toBe('')
    Object.assign(harness, { status: 'error', errorMsg: message })
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18next }, createElement(Setup)))
    expect(html).not.toContain('隔离损坏的补丁文件</button>')
  })

  it('provides manual UTF-8 recovery instructions in both locales', () => {
    for (const locale of Object.values(resources)) {
      const hint = (locale.translation as Record<string, string>)['errors.patch_layer_encoding_failed']
      expect(hint).toContain('UTF-8')
      expect(hint).toContain('{{detail}}')
      expect(hint).toContain('.broken-')
    }
  })

  it.each([
    ['zh-CN', '另存为 UTF-8', '隔离损坏的补丁文件', '安全模式'],
    ['en-US', 'save it as UTF-8', 'Quarantine broken patch files', 'Safe Mode'],
  ])('renders the localized encoding recovery controls in %s', async (language, instruction, quarantine, safeMode) => {
    await i18next.changeLanguage(language)
    const diagnosed = await attachStartupDiagnostics('INTERNAL_PLUGIN_PATCH_ENCODING_FAILED: /tmp/cordis.patch.yml: invalid UTF-8')
    Object.assign(harness, { status: 'error', errorMsg: diagnosed.message, patchLayerHint: diagnosed.patchLayerHint })

    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18next }, createElement(Setup)))
    expect(html).toContain(instruction)
    expect(html).toContain(`${quarantine}</button>`)
    expect(html).toContain(`${safeMode}</button>`)
  })

  it.each([
    ['zh-CN', 'safe 档案', '原档案的补丁文件保留不变'],
    ['en-US', 'safe profile', 'original profile’s patch file is left unchanged'],
  ])('describes the safe profile and unchanged original patch in %s', (language, profile, preserved) => {
    const hint = i18next.t('errors.patch_layer_encoding_failed', { lng: language })
    expect(hint).toContain(profile)
    expect(hint).toContain(preserved)
    expect(hint).toContain('home')
  })

  it.each(['zh-CN', 'en-US'])('mentions encoding damage in the safe-mode explanation in %s', (language) => {
    const hint = i18next.t('hints.safe_mode', { lng: language })
    expect(hint).toContain('UTF-8')
    expect(hint).toContain('home')
    expect(hint).toContain('.broken-')
  })

  it.each([
    ['zh-CN', '语法或编码'],
    ['en-US', 'syntax or encoding'],
  ])('provides encoding-aware restoration instructions after quarantine in %s', (language, repair) => {
    expect(i18next.t('patch.quarantined_toast', { lng: language })).toContain(repair)
  })

  it.each([
    ['zh-CN', '同样的解析错误'],
    ['en-US', 'same parse error'],
  ])('does not mislabel failed encoding quarantine as a parse error in %s', (language, misleading) => {
    expect(i18next.t('errors.patch_quarantine_failed', { lng: language })).not.toContain(misleading)
  })
})

describe('encoding recovery actions', () => {
  it.each([
    ['quarantine_broken_patch_layers', 'profiles/tauri/cordis.patch.yml'],
    ['quarantine_broken_patch_layers', 'cordis.patch.yml'],
    ['enter_safe_mode', 'cordis.patch.yml'],
  ])('starts only after %s reports the backup for %s', async (command, layer) => {
    const original = `/tmp/issue1118/${layer}`
    const backup = `${original}.broken-20261017220000`
    const runtimeInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation(async (name: string) => {
      if (name === command) {
        expect(harness.busyAction).toBe('repair')
        expect(invoke).not.toHaveBeenCalledWith('launch_harness')
        return { quarantined: [{ original, backup, error: 'invalid UTF-8' }], failures: [] }
      }
      return runtimeInvoke(name)
    })
    Object.assign(harness, { status: 'error', errorMsg: `INTERNAL_PLUGIN_PATCH_ENCODING_FAILED: ${original}: invalid UTF-8` })

    if (command === 'enter_safe_mode')
      await harness.enterSafeMode()
    else
      await harness.quarantineBrokenPatchLayers()

    expect(invoke.mock.calls.filter(([name]) => name === command)).toEqual([[command]])
    expect(invoke.mock.calls.filter(([name]) => name === 'launch_harness')).toEqual([['launch_harness']])
    if (command === 'enter_safe_mode')
      expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
    else
      expect(invoke).toHaveBeenCalledWith('shutdown_harness')
    expect(toast).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`${original} → ${backup}`), { variant: 'accent', timeout: 10_000 })
    expect(harness.status).toBe('ready')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.errorMsg).toBe('')
    expect(harness.patchLayerHint).toBe('')
    expect(harness.busyAction).toBe(null)
  })

  it.each(['quarantine_broken_patch_layers', 'enter_safe_mode'])('does not restart after %s cannot move the broken home patch', async (command) => {
    const failure = 'PATCH_LAYER_QUARANTINE_FAILED: /tmp/issue1118/cordis.patch.yml: Access is denied. (os error 5)'
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtimeInvoke = invoke.getMockImplementation()!
    invoke.mockImplementation(async (name: string) => {
      if (name === command)
        throw failure
      return runtimeInvoke(name)
    })

    if (command === 'enter_safe_mode')
      await harness.enterSafeMode()
    else
      await harness.quarantineBrokenPatchLayers()

    expect(logError).toHaveBeenCalledWith(expect.any(String), failure)
    expect(invoke.mock.calls.filter(([name]) => name === command)).toEqual([[command]])
    expect(invoke).not.toHaveBeenCalledWith('launch_harness')
    expect(invoke).not.toHaveBeenCalledWith('shutdown_harness')
    expect(invoke).not.toHaveBeenCalledWith('ensure_internal_plugins')
    expect(toast).not.toHaveBeenCalled()
    expect(harness.status).toBe('error')
    expect(harness.errorMsg).toBe(failure)
    expect(harness.patchLayerHint).toContain('Access is denied.')
    expect(harness.patchLayerHint).toContain('文件仍在原处')
    expect(harness.busyAction).toBe(null)
  })
})

describe('patch quarantine failures', () => {
  it('recognizes an aborted quarantine', () => {
    expect(containsQuarantineFailure(QUARANTINE_FAILURE)).toBe(true)
    // 成功路径上的解析失败提示不应被误判为隔离失败。
    expect(containsQuarantineFailure(REAL_FAILURE)).toBe(false)
  })

  it('extracts the path and rename error', () => {
    expect(quarantineFailureDetail(QUARANTINE_FAILURE)).toBe(
      'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml: Access is denied. (os error 5)',
    )
    expect(quarantineFailureDetail(REAL_FAILURE)).toBe('')
  })
})

/**
 * 补丁层悬空 insert：包被卸载后手写的 `insert` 还留在 `cordis.patch.yml` 里，
 * loader 抛 ERR_MODULE_NOT_FOUND 让整棵树加载失败。启动前预检把「哪个文件、
 * 哪一行、哪个包」以 JSON 挂在错误码之后，前端解析出来给提示与「移除悬空条目」入口。
 */
const ENTRY_UNRESOLVED = `PATCH_LAYER_ENTRY_UNRESOLVED: ${JSON.stringify({
  entries: [
    {
      layer: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\cordis.patch.yml',
      line: 3,
      id: 'file-edit',
      name: 'dsh-file-edit',
      declared: false,
    },
    {
      layer: 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml',
      line: 1,
      id: null,
      name: 'dsh-other',
      declared: true,
    },
  ],
})}`

describe('patch layer unresolved entries', () => {
  it('recognizes a dangling insert failure', () => {
    expect(containsPatchEntryUnresolved(ENTRY_UNRESOLVED)).toBe(true)
    expect(containsPatchEntryUnresolved(REAL_FAILURE)).toBe(false)
    expect(containsPatchEntryUnresolved('see PATCH_LAYER_ENTRY_UNRESOLVED for details')).toBe(false)
  })

  it('parses the structured detail', () => {
    expect(patchEntryUnresolvedEntries(ENTRY_UNRESOLVED)).toEqual([
      {
        layer: 'C:\\Users\\Administrator\\.dsh\\profiles\\web\\cordis.patch.yml',
        line: 3,
        id: 'file-edit',
        name: 'dsh-file-edit',
        declared: false,
      },
      {
        layer: 'C:\\Users\\Administrator\\.dsh\\cordis.patch.yml',
        line: 1,
        id: null,
        name: 'dsh-other',
        declared: true,
      },
    ])
  })

  it('parses a payload wrapped in other copy', () => {
    const wrapped = `Harness 在process-boot阶段失败：${ENTRY_UNRESOLVED}（退出码 1）`
    expect(patchEntryUnresolvedEntries(wrapped)).toHaveLength(2)
  })

  it('degrades to an empty list when the payload is unusable', () => {
    expect(patchEntryUnresolvedEntries('Harness 在process-boot阶段失败')).toEqual([])
    expect(patchEntryUnresolvedEntries('PATCH_LAYER_ENTRY_UNRESOLVED: not json')).toEqual([])
    expect(patchEntryUnresolvedEntries('PATCH_LAYER_ENTRY_UNRESOLVED: {"entries":{}}')).toEqual([])
  })
})

/**
 * 错误码与恢复入口的跨层契约：前端识别用的码必须与 Rust 预检抛出的码一致，
 * 错误页的按钮必须真的接到「移除悬空条目」命令上——漏注册 invoke 命令时，
 * 用户点下去只会得到一个 unknown command 报错，而这种链路断点在单测里最容易漏。
 */
describe('unresolved-entry recovery wiring', () => {
  const rustSource = readFileSync(
    new URL('../src-tauri/src/service/plugin/patch_entries.rs', import.meta.url),
    'utf8',
  )
  const handlerSource = readFileSync(
    new URL('../src-tauri/src/desktop/builder.rs', import.meta.url),
    'utf8',
  )
  const storeSource = readFileSync(
    new URL('../src/store/modules/harness/store.ts', import.meta.url),
    'utf8',
  )
  const setupSource = readFileSync(
    new URL('../src/layout/components/setup.tsx', import.meta.url),
    'utf8',
  )

  it('shares the error code with the Rust preflight', () => {
    expect(rustSource).toContain(`"${PATCH_ENTRY_UNRESOLVED_CODE}"`)
  })

  it('registers the strip command and calls it from the error page', () => {
    expect(handlerSource).toContain('crate::bridge::strip_unresolved_patch_entries')
    expect(storeSource).toContain('invoke<PatchEntryStripReport>(\'strip_unresolved_patch_entries\')')
    expect(setupSource).toContain('store.harness.stripUnresolvedPatchEntries()')
    expect(setupSource).toContain('buttons.strip_patch_entries')
  })

  it('keeps the two patch-layer recovery buttons mutually exclusive', () => {
    expect(setupSource).toContain('patchLayerHint !== \'\' && !patchEntriesUnresolved')
  })

  it('backs the file up before rewriting it', () => {
    expect(rustSource).toContain('backup_path(&layer, "bak"')
  })

  it('routes every recovery entry through the shared busy reservation', () => {
    for (const call of [
      'runPatchRepair(\'safe-mode\'',
      'runPatchRepair(\'quarantine\'',
      'runPatchRepair(\'strip\'',
    ]) {
      expect(storeSource).toContain(call)
    }
  })

  it('reserves the busy state before the repair callback gets to run', async () => {
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const repair = harness.runPatchRepair('safe-mode', async () => {
      await pending
    })
    // 忙态必须在修复动作的第一次 await 之前就占住：顺序反过来就等于没占，
    // 退出处理器的自动恢复会在修复途中把它自己的重启插进来。
    expect(harness.busyAction).toBe('repair')
    release()
    await repair
    expect(harness.status).toBe('ready')
    expect(harness.serviceHealthy).toBe(true)
    expect(harness.busyAction).toBe(null)
  })
})

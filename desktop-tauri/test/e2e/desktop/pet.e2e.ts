import type { DesktopApp } from '../support/desktop'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDesktopApp } from '../support/desktop'
import { completePreinstall } from '../support/preinstall'

const ASSEMBLY_TIMEOUT_MS = 900_000
const PET_WINDOW_TIMEOUT_MS = 30_000
const PET_SIZE_MIN = 50
const PET_SIZE_MAX = 200
const PET_SIZE_DEFAULT = 100

interface PetStatus {
  enabled?: boolean
  visible?: boolean
  active_pet?: string
  pet_size?: number | null
}

interface WindowWithDshErrors extends Window {
  __dshE2eErrors?: string[]
  __TAURI_INTERNALS__?: {
    invoke: (name: string, payload?: Record<string, unknown>) => Promise<unknown>
  }
}

function collectPageErrors(): void {
  const host = window as unknown as WindowWithDshErrors
  if (host.__dshE2eErrors)
    return

  const errors: string[] = []
  host.__dshE2eErrors = errors

  window.addEventListener('error', event => errors.push(`error: ${event.message}`))
  window.addEventListener('unhandledrejection', event => errors.push(`unhandledrejection: ${String(event.reason)}`))

  const originalConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    errors.push(`console.error: ${args.map(String).join(' ')}`)
    originalConsoleError(...args)
  }
}

function readPageErrors(): string[] {
  return (window as unknown as WindowWithDshErrors).__dshE2eErrors ?? []
}

function shellInvoke(cmd: string, args?: unknown): Promise<unknown> {
  const internals = (window as unknown as WindowWithDshErrors).__TAURI_INTERNALS__
  if (!internals) {
    throw new Error('壳层缺少 __TAURI_INTERNALS__：当前上下文不是 Tauri WebView')
  }
  return internals.invoke(cmd, args as Record<string, unknown> | undefined)
}

describe('桌面端桌宠独立窗口', () => {
  let app: DesktopApp

  beforeAll(async () => {
    app = await startDesktopApp()
    const browser = app.browser

    await browser.execute(collectPageErrors)
    await completePreinstall(browser, ASSEMBLY_TIMEOUT_MS)
    await setEnabled(false)
  }, ASSEMBLY_TIMEOUT_MS)

  afterAll(async () => {
    await app?.stop()
  })

  async function status(): Promise<PetStatus> {
    return (await app.browser.execute(shellInvoke, 'get_pet_status')) as PetStatus
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    await app.browser.execute(shellInvoke, 'set_pet_enabled', { enabled })
    await app.browser.waitUntil(
      async () => (await status()).enabled === enabled,
      { timeout: PET_WINDOW_TIMEOUT_MS, timeoutMsg: `把 enabled 写成 ${enabled} 后状态未收敛` },
    )
  }

  async function expectSizeRejected(outOfRange: number): Promise<void> {
    const browser = app.browser
    const retryCount = browser.options.connectionRetryCount
    browser.options.connectionRetryCount = 0

    try {
      await expect(
        browser.execute(shellInvoke, 'set_pet_size', { size: outOfRange }),
      ).rejects.toThrow(/PET_SIZE_OUT_OF_RANGE/)
    }
    finally {
      browser.options.connectionRetryCount = retryCount
    }
  }

  it('TC-PET-L3-02-004 桌宠尺寸边界：范围内接受、越界拒绝且不改状态', async () => {
    await setEnabled(true)

    for (const inRange of [PET_SIZE_MIN, PET_SIZE_MAX]) {
      await app.browser.execute(shellInvoke, 'set_pet_size', { size: inRange })
      expect((await status()).pet_size, `范围内提交 ${inRange} 必须被接受并落盘`).toBe(inRange)
    }

    const settled = (await status()).pet_size
    for (const outOfRange of [0, PET_SIZE_MIN - 1, PET_SIZE_MAX + 1, 999]) {
      await expectSizeRejected(outOfRange)
      expect(
        (await status()).pet_size,
        `越界提交 ${outOfRange} 不得改动已落盘的尺寸`,
      ).toBe(settled)
    }

    await app.browser.execute(shellInvoke, 'set_pet_size', { size: PET_SIZE_DEFAULT })
    expect((await status()).pet_size, '收尾必须恢复默认尺寸').toBe(PET_SIZE_DEFAULT)
    await setEnabled(false)

    expect(await app.browser.execute(readPageErrors), 'TC-PET-L3-02-004 尺寸边界：壳层出现报错').toEqual([])
  })
})

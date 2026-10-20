import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'

/** Tauri 2 在 Windows 上给壳层的 Web 源；内嵌服务帧始终从它加载 `http://127.0.0.1`。 */
const SHELL_ORIGIN = 'http://tauri.localhost'

function shippedString(file: URL, pattern: RegExp, reason: string): string {
  const value = readFileSync(file, 'utf8').match(pattern)?.[1]
  expect(value, reason).toBeDefined()
  return value!
}

function shellBrowserArgs(): string[] {
  return shippedString(
    new URL('../../../src-tauri/src/desktop/builder.rs', import.meta.url),
    /const WINDOWS_SHELL_BROWSER_ARGS: &str = "([^"]+)";/,
    'builder.rs 必须导出桌面壳的 WebView2 启动参数',
  ).split(' ')
}

function frameSandbox(): string {
  return shippedString(
    new URL('../../../src/layout/components/iframe.tsx', import.meta.url),
    /sandbox="([^"]+)"/,
    'iframe.tsx 必须声明内嵌帧的 sandbox 权限',
  )
}

it('desktop shell loads the loopback service in its sandboxed frame with the shipped Windows browser arguments', { timeout: 30_000 }, async () => {
  const args = shellBrowserArgs()
  const sandbox = frameSandbox()
  const server = createServer((_, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><div id="root">isolated harness service</div>')
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const browser = await chromium.launch({ headless: true, args })
  const failures: string[] = []
  try {
    const page = await browser.newPage()
    page.on('pageerror', error => failures.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error')
        failures.push(message.text())
    })
    page.on('requestfailed', request => failures.push(`${request.url()} ${request.failure()?.errorText ?? 'unknown network failure'}`))
    const port = (server.address() as AddressInfo).port
    const shellDocument = `<!doctype html><body><iframe sandbox="${sandbox}" src="http://127.0.0.1:${port}/?dshDesktop=1"></iframe></body>`
    await page.route(`${SHELL_ORIGIN}/**`, route => route.fulfill({
      contentType: 'text/html',
      body: shellDocument,
    }))
    await page.goto(`${SHELL_ORIGIN}/`)
    await expect.poll(
      () => page.frameLocator('iframe').locator('#root').textContent({ timeout: 2_000 }).catch(() => null),
      { timeout: 15_000, message: '桌面跨源沙箱帧应显示回环服务返回的文档' },
    ).toBe('isolated harness service')
    expect(failures, '页面加载不应触发本地网络拦截或脚本错误').toEqual([])
  }
  finally {
    await browser.close()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
})

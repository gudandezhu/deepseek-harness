import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mobileStyle from '../../../packages/dsh-tauri-mobile-ui/src/client/styles/mobile.cssr'

vi.mock('../../../packages/dsh-tauri/dist/client.cjs', () => import('../../../packages/dsh-tauri/src/client/utils/device'))
vi.mock('../../../packages/dsh-tauri-ui/dist/client.cjs', () => import('../../../packages/dsh-tauri-ui/src/client/utils/cssr'))

const MOBILE_MEDIA = '(hover: none) and (any-pointer: coarse) and (any-hover: none) and (max-width: 1023px)'
const HIDDEN = [
  '[data-slot="conversation.header"] [class$="_header"]',
  '[data-slot="conversation.composer.bar"] [class$="_dock"]',
  '[class$="_composerStack"] > [data-slot="conversation.input.dock"]',
]
const MARKUP = `<!doctype html><html data-dsh-mobile-ui><body>
  <div data-slot="conversation.session.header"><div data-slot="conversation.header"><header class="wSkVaW_header">Session title</header></div></div>
  <div data-slot="conversation.composer.bar"><div class="wSkVaW_dock">Queued messages</div></div>
  <div class="wSkVaW_composerStack"><div data-slot="conversation.input.dock"><div class="wSkVaW_dock">Steer panel</div></div></div>
</body></html>`

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
})

async function layout(viewport: { width: number, height: number }) {
  const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport })
  try {
    await page.setContent(MARKUP)
    await page.addStyleTag({ content: mobileStyle.render() })
    return {
      matches: await page.evaluate(media => matchMedia(media).matches, MOBILE_MEDIA),
      displays: await Promise.all(HIDDEN.map(selector => page.locator(selector).evaluate(element => getComputedStyle(element).display))),
    }
  }
  finally {
    await page.close()
  }
}

describe('mobile layout on touch devices', () => {
  it('keeps the session header, queue dock and steer dock on a touchscreen desktop window', async () => {
    const { matches, displays } = await layout({ width: 1280, height: 720 })

    expect(matches, '1280px 触屏窗口不得命中移动布局').toBe(false)
    expect(displays, '触屏桌面窗口不得隐藏会话头、排队插话面板与状态条').toEqual(['block', 'block', 'block'])
  })

  it('still hides them on a phone viewport', async () => {
    const { matches, displays } = await layout({ width: 390, height: 844 })

    expect(matches, '手机视口必须继续命中移动布局').toBe(true)
    expect(displays, '手机仍由顶栏与抽屉接管，三条桌面入口保持隐藏').toEqual(['none', 'none', 'none'])
  })

  it('switches exactly at the 1024px breakpoint of the official layout', async () => {
    expect((await layout({ width: 1024, height: 720 })).matches, '1024px 与官方布局同门槛，交还桌面').toBe(false)
    expect((await layout({ width: 1023, height: 720 })).matches, '1023px 仍是移动布局').toBe(true)
  })
})

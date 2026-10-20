import type { Browser } from 'playwright'
import type { DshPage } from '../support/browser'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { expectNoSyntheticFallbacks, launchDshBrowser, newDshPage } from '../support/browser'

const OFFICIAL_PAGE = '[data-dsh-extension-plugins] [data-plugin-panel]'
const MAIN_HEADER = 'header:has(> div:first-child > h1)'
const BACK = '[data-dsh-plugins-back]'

let browser: Browser
beforeAll(async () => {
  browser = await launchDshBrowser()
})
afterAll(async () => {
  await browser?.close()
})

async function openPlugins(app: DshPage, touch = false): Promise<void> {
  if (touch) {
    await app.frame.locator('[data-dsh-mobile-sidebar-toggle]').tap()
    await expect.poll(() => app.frame.locator('html[data-dsh-mobile-sidebar-open]').count(), { message: '触屏侧栏必须真实展开' }).toBe(1)
    const row = app.frame.getByRole('button', { name: '插件扩展', exact: true })
    await row.tap()
    await expect.poll(() => row.getAttribute('aria-current'), { message: '触屏点击必须真实激活插件扩展入口' }).toBe('page')
    await app.frame.locator(OFFICIAL_PAGE).waitFor({ state: 'visible' })
    await app.frame.locator('[data-dsh-mobile-sidebar-shade]').tap()
    await expect.poll(() => app.frame.locator('html[data-dsh-mobile-sidebar-open]').count(), { message: '进入插件面板后必须真实收起触屏侧栏以解除主槽 inert' }).toBe(0)
  }
  else {
    await app.frame.getByRole('button', { name: '插件扩展', exact: true }).click()
  }
  await app.frame.locator(OFFICIAL_PAGE).waitFor({ state: 'visible' })
}

describe('extension panel official plugins composition', () => {
  it('hides the original sidebar row and mounts the official page only while its first tab is active', async () => {
    const app = await newDshPage(browser, { ready: '[data-dsh-hidden-panel="plugins"]' })
    try {
      const originalRow = app.frame.locator('button:has([data-dsh-hidden-panel="plugins"])')
      expect(await originalRow.count(), '原插件入口必须保留注册但隐藏整行').toBe(1)
      expect(await originalRow.evaluate(el => getComputedStyle(el).display), '原插件入口必须隐藏布局').toBe('none')
      expect(await originalRow.isVisible(), '原插件入口不得重复展示').toBe(false)

      await openPlugins(app)
      const tabs = app.frame.getByRole('tablist', { name: '插件扩展' })
      const pluginsTab = tabs.getByRole('tab', { name: '插件', exact: true })
      await expect.poll(() => tabs.getByRole('tab').first().textContent(), { message: '官方插件必须是首个 Tab' }).toBe('插件')
      await expect.poll(() => pluginsTab.getAttribute('aria-selected'), { message: '打开入口必须选中官方插件 Tab' }).toBe('true')

      const officialPage = app.frame.locator(OFFICIAL_PAGE)
      expect(await officialPage.count(), '只能挂载一个真实官方插件页面').toBe(1)
      expect(await officialPage.evaluate((el) => {
        const style = getComputedStyle(el)
        return { padding: style.padding, overflow: style.overflow }
      }), '官方页必须由外层插件面板管理滚动与内边距').toEqual({ padding: '0px', overflow: 'visible' })
      const header = officialPage.locator(MAIN_HEADER)
      expect(await header.evaluate(el => getComputedStyle(el).paddingTop), '两端基线主页页头均不得叠加顶距').toBe('0px')

      const heading = header.locator(':scope > div:first-child > h1')
      const intro = header.locator(':scope > div:first-child > :is(p, div)')
      const titleStyle = await heading.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
      })
      const introStyle = await intro.evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
      })
      expect(titleStyle, '官方标题必须使用插件面板的统一字号').toEqual({ fontSize: '16px', lineHeight: '24px', fontWeight: '500' })
      expect(introStyle, '官方简介必须使用插件面板的统一字号').toMatchObject({ fontSize: '12px', lineHeight: '18px' })
      expect(await header.evaluate(el => getComputedStyle(el).rowGap), '主页标题与简介间距必须保持一致').toBe('14px')
      const sparkle = app.frame.locator('[data-dsh-plugins-icon] svg')
      expect(await sparkle.isVisible(), '官方闪光图标必须出现在主页页头').toBe(true)
      expect(await sparkle.getAttribute('width'), '主页图标不得放大').toBe('16')

      await expect.poll(() => officialPage.locator('[data-plugin-item]').count(), { timeout: 15_000, message: '必须加载真实官方插件条目' }).toBeGreaterThan(0)
      await officialPage.locator('[data-plugin-item]').first().getByRole('button').first().click()
      const detail = officialPage.locator('[data-plugin-item-detail]')
      await detail.waitFor({ state: 'visible' })
      const minimum = inject('dshCoreVersion') === '0.1.7-rc.1'
      const detailTop = minimum
        ? detail.locator(':scope > button:first-child')
        : detail.locator(':scope > div[data-window-drag]')
      expect(await detailTop.evaluate((el, isMinimum) => {
        const style = getComputedStyle(el)
        return isMinimum ? style.marginTop : style.paddingTop
      }, minimum), '两端基线详情顶部间距必须为 12px').toBe('12px')
      expect(await sparkle.isVisible(), '详情页不显示主页图标').toBe(false)
      const detailBack = detail.getByRole('button', { name: inject('dshCoreVersion') === '0.1.7-rc.1' ? '返回插件列表' : '返回插件', exact: true })
      expect(await detailBack.count(), '官方详情必须保留唯一原生返回入口').toBe(1)
      expect(await detailBack.evaluate(el => el.getBoundingClientRect().top - el.closest('[data-plugin-item-detail]')!.getBoundingClientRect().top), '原生返回入口距详情顶部必须真实留出 12px').toBeCloseTo(12, 1)
      expect(await detailBack.getAttribute('data-dsh-plugins-back'), '详情返回不得冒充更多页回退').toBeNull()
      await detailBack.click()
      await header.waitFor({ state: 'visible' })

      await tabs.getByRole('tab', { name: '技能', exact: true }).click()
      const skillsPanel = app.frame.getByRole('tabpanel', { name: '技能', exact: true, includeHidden: true })
      await expect.poll(() => skillsPanel.isVisible(), { message: '技能 Tab 必须正常挂载' }).toBe(true)
      expect(await skillsPanel.locator(':scope > div > div:first-child > h3').evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, fontWeight: style.fontWeight }
      }), '插件标题尺寸必须与技能页一致').toEqual(titleStyle)
      expect(await skillsPanel.locator(':scope > div > p').first().evaluate((el) => {
        const style = getComputedStyle(el)
        return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
      }), '插件描述尺寸和颜色必须与技能页一致').toEqual(introStyle)
      await expect.poll(() => app.frame.locator('[data-plugin-panel]').count(), { message: '离开插件 Tab 必须卸载官方页面，不能仅 hidden' }).toBe(0)

      await tabs.getByRole('tab', { name: 'MCP', exact: true }).click()
      expect(await skillsPanel.count(), '其他已访问 Tab 仍须保留挂载').toBe(1)
      expect(await skillsPanel.isVisible(), '非活动技能页必须隐藏').toBe(false)
      await pluginsTab.click()
      await expect.poll(() => officialPage.isVisible(), { message: '切回插件 Tab 必须恢复官方页面' }).toBe(true)
      expect(await originalRow.isVisible(), '原侧栏入口不得因重挂载复现').toBe(false)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '复用官方页面和切换 Tab 不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })

  it.each([
    { name: '桌面', width: 1400, height: 900, touch: false },
    { name: '触屏', width: 399, height: 938, touch: true },
  ])('$name：更多只保留唯一回退，返回原主页且标题、图标和按钮互不遮挡', async ({ width, height, touch }) => {
    const app = await newDshPage(browser, {
      ready: '[data-dsh-hidden-panel="plugins"]',
      viewport: { width, height },
      hasTouch: touch,
      isMobile: touch,
    })
    try {
      await openPlugins(app, touch)
      const officialPage = app.frame.locator(OFFICIAL_PAGE)
      const tabs = app.frame.getByRole('tablist', { name: '插件扩展' })
      const initialTabs = await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent })))
      const selectedTab = await tabs.getByRole('tab', { selected: true }).getAttribute('id')
      const mainHeader = officialPage.locator(MAIN_HEADER)
      const originalTitle = await mainHeader.locator('h1').textContent()
      const mainGeometry = await officialPage.evaluate((el) => {
        const wrapper = el.closest('[data-dsh-extension-plugins]')!
        const header = el.querySelector(':scope > header')!
        const title = header.querySelector('h1')!
        const icon = wrapper.querySelector('[data-dsh-plugins-icon]')!
        const titleBox = title.getBoundingClientRect()
        const iconBox = icon.getBoundingClientRect()
        return {
          headerPaddingTop: getComputedStyle(header).paddingTop,
          titleCenter: titleBox.top + titleBox.height / 2,
          iconCenter: iconBox.top + iconBox.height / 2,
          titleLeft: titleBox.left,
          iconLeft: iconBox.left,
          iconWidth: iconBox.width,
          titlePaddingLeft: Number.parseFloat(getComputedStyle(title).paddingLeft),
        }
      })
      expect(mainGeometry.headerPaddingTop, '主页页头不得叠加主槽的顶距').toBe('0px')
      expect(Math.abs(mainGeometry.iconCenter - mainGeometry.titleCenter), '闪光图标必须与主页标题同轴').toBeLessThanOrEqual(1)
      expect(mainGeometry.iconLeft, '图标必须落在标题的左内边距内').toBeCloseTo(mainGeometry.titleLeft, 1)
      expect(mainGeometry.iconWidth + 10, '图标盒加 10px 间距必须等于标题的 32px 缩进').toBeCloseTo(mainGeometry.titlePaddingLeft, 1)
      expect(await officialPage.locator(BACK).count(), '主页不得伪造回退按钮').toBe(0)

      if (inject('dshCoreVersion') === '0.1.7-rc.1') {
        expect(await officialPage.getByRole('button', { name: '更多', exact: true }).count(), '最低基线没有官方更多页，不得由桌面插件伪造').toBe(0)
        await expect.poll(() => officialPage.locator('[data-plugin-item]').count(), { message: '最低基线必须实际加载官方插件列表' }).toBeGreaterThan(0)
      }
      else {
        const more = officialPage.locator('[data-plugin-group="extensions"]').getByRole('button', { name: '更多', exact: true })
        await expect.poll(() => more.count(), { timeout: 15_000, message: 'rc.1 必须提供唯一真实官方更多入口' }).toBe(1)
        await more.click()
        await officialPage.locator('[data-plugin-group="more"]').waitFor({ state: 'visible' })
        await expect.poll(() => officialPage.locator(BACK).count(), { message: '更多页只能有一个回退按钮' }).toBe(1)
        const back = officialPage.locator(BACK)
        expect(await back.getAttribute('aria-label'), '回退按钮必须有本地化无障碍名称').toBe('回退')
        expect(await back.textContent(), '回退按钮必须显示中文文案').toBe('回退')
        expect(await officialPage.getByRole('button', { name: '回退', exact: true }).count(), '不可有重复的可访问回退入口').toBe(1)
        expect(await back.locator('span').count(), '回退文案不得重复注入').toBe(1)
        expect(await back.locator('svg').count(), '必须保留官方原生回退图标').toBe(1)
        expect(await app.frame.locator('[data-dsh-plugins-icon]').isVisible(), '更多页不得叠加主页闪光图标').toBe(false)
        const geometry = await officialPage.evaluate((el) => {
          const header = el.querySelector(':scope > header')!
          const button = header.querySelector('[data-dsh-plugins-back]')!
          const title = header.querySelector(':scope > h1')!
          const icon = button.querySelector('svg')!
          const label = button.querySelector('span')!
          const rect = (node: Element) => {
            const box = node.getBoundingClientRect()
            return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
          }
          return {
            header: rect(header),
            button: rect(button),
            title: rect(title),
            icon: rect(icon),
            label: rect(label),
            titlePadding: getComputedStyle(title).paddingLeft,
            headerPadding: getComputedStyle(header).paddingTop,
          }
        })
        expect(geometry.headerPadding, '更多页页头不得残留主页顶距').toBe('0px')
        expect(geometry.titlePadding, '更多页标题不得残留主页图标缩进').toBe('0px')
        expect(geometry.button.width, '回退按钮必须真实占据可点击空间').toBeGreaterThan(28)
        expect(geometry.label.width, '中文回退文案必须真实可见').toBeGreaterThan(0)
        expect(geometry.icon.width, '官方回退图标必须真实可见').toBeGreaterThan(0)
        expect(geometry.icon.right, '回退图标和中文文案不得相交').toBeLessThanOrEqual(geometry.label.left)
        expect(geometry.button.right + 9, '回退按钮与实验性插件标题必须保留间距且不相交').toBeLessThanOrEqual(geometry.title.left)
        expect(Math.abs((geometry.button.top + geometry.button.bottom - geometry.title.top - geometry.title.bottom) / 2), '回退与更多标题必须同轴').toBeLessThanOrEqual(1)
        expect(geometry.title.right, '更多标题不得越出页头').toBeLessThanOrEqual(geometry.header.right + 1)
        expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent }))), '进入更多不得重建或改写外层 Tab').toEqual(initialTabs)
        expect(await tabs.getByRole('tab', { selected: true }).getAttribute('id'), '进入更多不得切换外层 Tab').toBe(selectedTab)

        await back.click()
        await mainHeader.waitFor({ state: 'visible' })
        await expect.poll(() => officialPage.locator(BACK).count(), { message: '返回主页必须回收回退标记' }).toBe(0)
        expect(await mainHeader.locator('h1').textContent(), '回退必须返回原官方主页而非重定向到其他面板').toBe(originalTitle)
        expect(await officialPage.locator('[data-plugin-group="more"]').count(), '回退后必须卸载更多页').toBe(0)
        expect(await app.frame.locator('[data-dsh-plugins-icon]').isVisible(), '返回主页必须恢复闪光图标').toBe(true)
      }
      expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(element => ({ id: element.id, text: element.textContent }))), '导航往返必须保留原外层 Tab').toEqual(initialTabs)
      expect(await tabs.getByRole('tab', { selected: true }).getAttribute('id'), '导航往返必须保留原选中 Tab').toBe(selectedTab)
      expectNoSyntheticFallbacks(app)
      expect(app.errors, '两端基线真实官方页面导航不得产生浏览器错误').toEqual([])
    }
    finally {
      await app.close()
    }
  })
})

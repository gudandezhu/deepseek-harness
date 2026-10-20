// @vitest-environment jsdom
import type { IframeProps } from './iframe'
import type { NavbarProps } from './navbar'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Webview } from './webview'

const mocks = vi.hoisted(() => ({
  navbar: vi.fn<(props: NavbarProps) => void>(),
  shortcuts: { rows: [] },
  setShortcuts: vi.fn(),
  harness: { status: 'ready', serviceHealthy: true, serviceRunning: true, iframeKey: 0, iframeLoaded: false, iframeAlive: false, iframeError: false, startupPhase: 'process-boot', busyAction: null },
  recovery: { recovery: { required: false } },
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'window-2' }) }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'windows' }))
vi.mock('valtio-define', () => ({ useStore: (value: unknown) => value }))
vi.mock('@/store', () => ({ store: { harness: mocks.harness, recovery: mocks.recovery } }))
vi.mock('@/hooks/use-appearance', () => ({ useAppearance: () => '' }))
vi.mock('@/hooks/use-dsh-style', () => ({ useDshStyle: () => [{}] }))
vi.mock('@/hooks/use-dsh-shortcuts', () => ({
  DSH_VIEW_COMMANDS: [],
  shortcutHint: vi.fn(),
  useDshShortcuts: () => [mocks.shortcuts, mocks.setShortcuts],
}))
vi.mock('@/hooks/use-listen', () => ({ useListen: vi.fn() }))
vi.mock('@/ui/plugin/recovery', () => ({ Recovery: () => null }))
vi.mock('./setup', () => ({ Setup: () => null }))
vi.mock('./setup-preinstall', () => ({ PreinstallSetup: () => null }))
vi.mock('./navbar', () => ({
  Navbar: (props: NavbarProps) => {
    mocks.navbar(props)
    return null
  },
}))
vi.mock('./iframe', () => ({
  Iframe: ({ iframeRef, srcOverride }: IframeProps) => (
    <iframe key={srcOverride} ref={iframeRef} src={srcOverride ?? 'http://127.0.0.1:3081'} title="session" />
  ),
}))

it('logs the selected shell branch and deduplicates unrelated rerenders without exposing remote URLs', () => {
  window.location.hash = ''
  const view = render(<Webview />)
  expect(console.warn).toHaveBeenLastCalledWith('[Webview] shell view', expect.objectContaining({
    branch: 'iframe',
    status: 'ready',
    remoteMode: false,
    serviceHealthy: true,
    iframeKey: 0,
    iframeLoaded: false,
    iframeAlive: false,
    iframeError: false,
  }))
  view.rerender(<Webview />)
  expect(console.warn).toHaveBeenCalledTimes(1)
  mocks.harness.status = 'error'
  view.rerender(<Webview />)
  expect(console.warn).toHaveBeenLastCalledWith('[Webview] shell view', expect.objectContaining({ branch: 'setup' }))
  mocks.recovery.recovery.required = true
  view.rerender(<Webview />)
  expect(console.warn).toHaveBeenLastCalledWith('[Webview] shell view', expect.objectContaining({ branch: 'recovery' }))
  mocks.harness.status = 'preinstall'
  view.rerender(<Webview />)
  expect(console.warn).toHaveBeenLastCalledWith('[Webview] shell view', expect.objectContaining({ branch: 'preinstall' }))
  mocks.harness.status = 'ready'
  mocks.harness.serviceHealthy = false
  view.rerender(<Webview />)
  act(() => navbar().onRemoteChange('https://example.test/?token=secret', null))
  expect(console.warn).toHaveBeenLastCalledWith('[Webview] shell view', expect.objectContaining({ branch: 'iframe', remoteMode: true, serviceHealthy: false }))
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret')
  expect(console.warn).toHaveBeenCalledTimes(6)
})

function navbar() {
  return mocks.navbar.mock.lastCall![0]
}

beforeEach(() => {
  vi.useFakeTimers()
  window.location.hash = ''
  Object.assign(mocks.harness, { status: 'ready', serviceHealthy: true })
  mocks.recovery.recovery.required = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.navbar.mockClear()
  mocks.setShortcuts.mockClear()
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

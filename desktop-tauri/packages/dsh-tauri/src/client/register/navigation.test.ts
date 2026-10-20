import type { ClientContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigationFeature } from './navigation'

const CMD_NEW_SESSION = 'dsh://session:new'
const CMD_ADD_WORKSPACE = 'dsh://workspace:add'
const NAVIGATION_GLOBAL = '__DSH_NAVIGATION__'

interface Host {
  post: ReturnType<typeof vi.fn>
  window: Record<string, unknown>
  dispatch: (data: unknown) => void
}

function stubHost(): Host {
  const listeners = new Set<(event: MessageEvent) => void>()
  const parent = { postMessage: vi.fn() }
  const storage = new Map<string, string>()
  const host: Record<string, unknown> = {
    parent,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
    },
    addEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: (event: MessageEvent) => void) => listeners.delete(handler),
  }
  vi.stubGlobal('window', host)
  return {
    post: parent.postMessage,
    window: host,
    dispatch: (data) => {
      for (const handler of [...listeners])
        handler({ source: parent, data } as unknown as MessageEvent)
    },
  }
}

function ctxWithServices(services: Record<string, unknown>): ClientContext {
  return { get: (name: string) => services[name] } as unknown as ClientContext
}

function stubSessions(ids: () => string[], subscribe = vi.fn()) {
  return { list: { getSnapshot: () => ({ ids: ids() }), subscribe } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('navigationFeature', () => {
  it('会话列表就绪后消费一次性注入的跳转目标，并清除注入载荷', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    let ids: string[] = []
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ids),
      uiWorkspace: { openSession },
    }))

    expect(host.window[NAVIGATION_GLOBAL]).toBeUndefined()
    expect(openSession).not.toHaveBeenCalled()

    ids = ['other', 'target']
    await vi.advanceTimersByTimeAsync(500)
    expect(openSession).toHaveBeenCalledExactlyOnceWith('target')

    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).toHaveBeenCalledOnce()
    expect(host.post).not.toHaveBeenCalled()
    dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同一窗口的帧内重载不再重复打开已消费的跳转目标', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const openSession = vi.fn()
    const services = {
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }

    const dispose = navigationFeature.call(ctxWithServices(services))
    await vi.advanceTimersByTimeAsync(0)
    expect(openSession).toHaveBeenCalledOnce()
    dispose()

    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const reloaded = navigationFeature.call(ctxWithServices(services))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).toHaveBeenCalledOnce()
    expect(host.post).not.toHaveBeenCalled()
    reloaded()
  })

  it('没有注入载荷时不打开任何会话', async () => {
    const host = stubHost()
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))

    await vi.advanceTimersByTimeAsync(31_000)
    expect(openSession).not.toHaveBeenCalled()
    expect(host.post).not.toHaveBeenCalled()
    dispose()
  })

  it('目标会话始终缺席时上报插件错误而不是静默半工作', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'missing' }
    const openSession = vi.fn()

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openSession).not.toHaveBeenCalled()
    expect(host.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dsh://plugin-error',
        error: expect.stringContaining('missing'),
        action: 'runtime',
      }),
      '*',
    )
    dispose()
  })

  it('打开会话失败时上报插件错误', async () => {
    const host = stubHost()
    host.window[NAVIGATION_GLOBAL] = { sessionId: 'target' }
    const openSession = vi.fn(() => Promise.reject(new Error('load failed')))

    const dispose = navigationFeature.call(ctxWithServices({
      sessions: stubSessions(() => ['target']),
      uiWorkspace: { openSession },
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(host.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'dsh://plugin-error',
        error: 'Error: load failed',
      }),
      '*',
    )
    dispose()
  })

  it('dsh://session:new 走官方 startSession，其它 type 不触发', async () => {
    const host = stubHost()
    const startSession = vi.fn()
    const dispose = navigationFeature.call(ctxWithServices({ uiWorkspace: { startSession } }))

    host.dispatch({ type: 'dsh://other' })
    host.dispatch({ type: CMD_NEW_SESSION })

    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1))
    dispose()
  })

  it('dsh://workspace:add 走选目录 → 建工作区 → 在新工作区开会话', async () => {
    const startSession = vi.fn()
    const pickDirectory = vi.fn(async () => 'C:/ws')
    const create = vi.fn(async () => ({ workspaceId: 'ws-1' }))
    const host = stubHost()
    const dispose = navigationFeature.call(ctxWithServices({ workspaces: { create }, uiWorkspace: { startSession, pickDirectory } }))

    host.dispatch({ type: CMD_ADD_WORKSPACE })

    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ path: 'C:/ws' }))
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledWith('ws-1'))
    dispose()
  })

  it('官方服务缺席时退级为点官方按钮', async () => {
    const clicked: string[] = []
    vi.stubGlobal('document', {
      querySelector: (selector: string) => ({
        click: () => clicked.push(selector),
      }),
    })
    const host = stubHost()
    const dispose = navigationFeature.call(ctxWithServices({}))

    host.dispatch({ type: CMD_NEW_SESSION })
    host.dispatch({ type: CMD_ADD_WORKSPACE })

    await vi.waitFor(() => expect(clicked).toHaveLength(2))
    expect(clicked[0]).toContain('新建会话')
    expect(clicked[1]).toContain('添加工作区')
    dispose()
  })
})

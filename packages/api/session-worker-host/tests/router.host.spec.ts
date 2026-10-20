/** The host router keeps cold reads local and sends Agent writes to one worker. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionWorkerLives } from '@deepseek-ai/dsh-api-session-controller'
import type { TypertEndpointRouter } from '@deepseek-ai/dsh-api-gateway'
import type { SessionWorkerHandle, SessionWorkerSupervisor } from '@deepseek-ai/dsh-session-worker-supervisor'
import { SessionWorkerRouter } from '../src/router.ts'

const sessionId = 'session-router' as SessionId
const owner = { principal: { kind: 'owner' }, signal: new AbortController().signal } as unknown as PeerScope
const payload = (args: Record<string, unknown>) => ({ args })

function setup(options: { readonly live?: boolean; readonly decision?: { kind: 'deny'; reason: string } } = {}) {
  const ctx = new Context()
  ctx.provide('remoteAccess', {
    decide: () => options.decision ?? { kind: 'allow' },
  } as never)
  const call = vi.fn(async (..._args: unknown[]): Promise<ConnectionRpcResult<unknown>> => ({ ok: true, value: { accepted: true } }))
  const open = vi.fn(() => (async function* () {})())
  const handle = { sessionId, pid: 1, exited: Promise.resolve(), call, open } as unknown as SessionWorkerHandle
  const get = vi.fn(() => options.live === true ? handle : undefined)
  const acquired = vi.fn(async () => handle)
  const supervisor = { get, acquire: acquired } as unknown as SessionWorkerSupervisor
  const attach = vi.fn()
  const lives = { attach } as unknown as SessionWorkerLives
  return { router: new SessionWorkerRouter(ctx, supervisor, lives, undefined), call, open, get, acquired, attach }
}

describe('Session worker host router', () => {
  it('claims only write endpoints and spawns on the first prompt', async () => {
    const { router, call, acquired, attach } = setup()
    expect(router.claims('session/prompt')).toBe(true)
    expect(router.claims('session/follow')).toBe(false)
    expect(router.claims('session/list')).toBe(false)
    const endpointRouter: TypertEndpointRouter = router
    expect(endpointRouter.stream?.('session/control', payload({}), (async function* () {})(), new AbortController().signal, owner))
      .toBeUndefined()

    await expect(router.dispatch?.('session/prompt', payload({ request: { sessionId } }), new AbortController().signal, owner))
      .resolves.toEqual({ ok: true, value: { accepted: true } })
    expect(acquired).toHaveBeenCalledWith(sessionId)
    expect(attach).toHaveBeenCalledWith(sessionId, expect.anything())
    const forwarded = call.mock.calls[0] as unknown as [string, unknown, { readonly signal: AbortSignal }]
    expect(forwarded[0]).toBe('session/prompt')
    expect(forwarded[1]).toEqual({ request: { sessionId } })
    expect(forwarded[2].signal).toBeInstanceOf(AbortSignal)
  })

  it('leaves a cold cancel and a cold job kill to the host', async () => {
    const { router, acquired } = setup()
    expect(router.dispatch('session/cancel', payload({ request: { sessionId } }), new AbortController().signal, owner))
      .toBeUndefined()
    expect(router.dispatch('job/kill', payload({ request: { sessionId, jobId: 'job-1' } }), new AbortController().signal, owner))
      .toBeUndefined()
    expect(acquired).not.toHaveBeenCalled()
  })

  it('mints a Session identity for an unnamed create and attaches after success', async () => {
    const { router, call, attach } = setup()
    await router.dispatch?.('session/create', payload({ request: { cwd: '/repo' } }), new AbortController().signal, owner)
    const forwarded = call.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(forwarded[0]).toBe('session/create')
    expect((forwarded[1]['request'] as Record<string, unknown>)['cwd']).toBe('/repo')
    expect(String((forwarded[1]['request'] as Record<string, unknown>)['sessionId'])).toMatch(/^session-/)
    expect(attach).toHaveBeenCalledWith((forwarded[1]['request'] as Record<string, unknown>)['sessionId'], expect.anything())
  })

  it('denies a non-owner before spawning or forwarding', async () => {
    const { router, call, acquired } = setup({ decision: { kind: 'deny', reason: 'no-allow' } })
    const result = await router.dispatch?.('session/prompt', payload({ request: { sessionId } }), new AbortController().signal, owner)
    expect(result).toMatchObject({ ok: false, error: { code: 'remote-access/denied' } })
    expect(acquired).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('routes a fork to the worker that owns the source Session', async () => {
    const { router, call, acquired } = setup()
    await router.dispatch?.('session/fork', payload({ request: { sessionId } }), new AbortController().signal, owner)
    expect(acquired).toHaveBeenCalledWith(sessionId)
    const forwarded = call.mock.calls[0] as unknown as [string, unknown, { readonly signal: AbortSignal }]
    expect(forwarded[0]).toBe('session/fork')
    expect(forwarded[1]).toEqual({ request: { sessionId } })
    expect(forwarded[2].signal).toBeInstanceOf(AbortSignal)
  })

  it('delivers a Schedule reminder to the worker that owns the Session', async () => {
    const { router, call, acquired, attach } = setup()
    expect(router.claims('session/deliverReminder')).toBe(true)
    await expect(router.deliverReminder(sessionId, 'reminder text')).resolves.toEqual({ accepted: true })
    expect(acquired).toHaveBeenCalledWith(sessionId)
    expect(attach).toHaveBeenCalledWith(sessionId, expect.anything())
    const forwarded = call.mock.calls[0] as unknown as [string, unknown, { readonly signal: AbortSignal }]
    expect(forwarded[0]).toBe('session/deliverReminder')
    expect(forwarded[1]).toEqual({ request: { sessionId, text: 'reminder text' } })
    expect(forwarded[2].signal).toBeInstanceOf(AbortSignal)
  })

  it('surfaces a worker delivery failure to the Schedule caller', async () => {
    const { router, call } = setup()
    call.mockResolvedValueOnce({
      ok: false,
      error: { code: 'session/not-found', message: 'gone', details: {} },
    })
    await expect(router.deliverReminder(sessionId, 'reminder text')).rejects.toThrow('gone')
  })

  it('routes job observation streams to a live owner and leaves cold Sessions to the Host', () => {
    const cold = setup()
    const signal = new AbortController().signal
    const uplink = (async function* () {})()
    expect(cold.router.claims('job/list')).toBe(false)
    expect(cold.router.stream('job/list', payload({ request: { sessionId } }), uplink, signal, owner))
      .toBeUndefined()
    expect(cold.router.stream('job/follow', payload({ request: { sessionId, jobId: 'job-1' } }), uplink, signal, owner))
      .toBeUndefined()

    const live = setup({ live: true })
    expect(live.router.stream('job/list', payload({ request: { sessionId } }), uplink, signal, owner))
      .toBeDefined()
    expect(live.router.stream('job/follow', payload({ request: { sessionId, jobId: 'job-1' } }), uplink, signal, owner))
      .toBeDefined()
    expect(live.open).toHaveBeenCalledWith('job/list', { request: { sessionId } }, { signal })
    expect(live.open).toHaveBeenCalledWith('job/follow', { request: { sessionId, jobId: 'job-1' } }, { signal })
    expect(live.acquired).not.toHaveBeenCalled()
  })

  it('fails a denied job stream before opening a worker stream', async () => {
    const { router, open } = setup({ live: true, decision: { kind: 'deny', reason: 'no-allow' } })
    const stream = router.stream(
      'job/list', payload({ request: { sessionId } }), (async function* () {})(), new AbortController().signal, owner,
    )
    expect(stream).toBeDefined()
    const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('access denied')
    expect(open).not.toHaveBeenCalled()
  })

  it('uses an existing worker without acquiring a new one', async () => {
    const { router, call, acquired, get } = setup({ live: true })
    await router.dispatch?.('session/rename', payload({ request: { sessionId, title: 'new' } }), new AbortController().signal, owner)
    expect(get).toHaveBeenCalledWith(sessionId)
    expect(acquired).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledOnce()
  })
})

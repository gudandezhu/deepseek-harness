/** The optional endpoint router runs before descriptor resolution and Service lookup. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  apply as applyConnection,
  inject as connectionInject,
} from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertEndpointRouter } from '../src/types.ts'
import TypertGatewayService from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'
import { ownerPeer } from './peer.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(router: TypertEndpointRouter): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  ctx.provide('sessionWorkerRouter', router)
  return ctx
}

function rpc(ctx: Context, endpoint: string, args: Record<string, unknown>): Promise<Response> {
  const [namespace, method] = endpoint.split('/') as [string, string]
  return ctx.connection.createSharedFetchHandler('/api').fetch(new Request(`http://host/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `rpc-${endpoint}`,
      method: `${namespace}/${method}`,
      payload: { args },
    }),
  }), ownerPeer(ctx))
}

describe('Gateway endpoint router', () => {
  it('answers a routed unary endpoint before any descriptor or Service lookup', async () => {
    const dispatch = vi.fn(() => Promise.resolve({ ok: true as const, value: { accepted: true } }))
    const ctx = await setup({ claims: endpoint => endpoint === 'session/prompt', dispatch })
    const response = await rpc(ctx, 'session/prompt', { request: { sessionId: 'session-1' } })
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'rpc-session/prompt',
      result: { ok: true, value: { accepted: true } },
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.slice(0, 2)).toEqual([
      'session/prompt',
      { args: { request: { sessionId: 'session-1' } } },
    ])
  })

  it('falls through to normal dispatch when the router does not own the endpoint', async () => {
    const dispatch = vi.fn(() => undefined)
    const ctx = await setup({ claims: endpoint => endpoint === 'session/prompt', dispatch })
    const response = await rpc(ctx, 'session/prompt', {})
    expect(await response.json()).toMatchObject({
      type: 'server-response',
      result: { ok: false, error: { code: 'gateway/invocation-unavailable' } },
    })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('turns a router failure into a gateway failure envelope', async () => {
    const ctx = await setup({
      claims: endpoint => endpoint === 'session/prompt',
      dispatch: () => Promise.reject(new Error('worker is unavailable')),
    })
    const response = await rpc(ctx, 'session/prompt', {})
    expect(await response.json()).toMatchObject({
      type: 'server-response',
      result: { ok: false, error: { code: 'gateway/internal', message: 'worker is unavailable' } },
    })
  })

  it('answers a routed logical stream before descriptor resolution', async () => {
    const stream = vi.fn(async function* (): AsyncIterable<unknown> {
      yield 'first'
      yield 'second'
    })
    const ctx = await setup({ stream })
    const source = await ctx.typertGateway.wireStream.open(
      'job/follow',
      { args: { request: { jobId: 'job-1' } } },
      (async function* () {})(),
      ownerPeer(ctx),
      new AbortController().signal,
    )
    const items: unknown[] = []
    for await (const item of source) items.push(item)
    expect(items).toEqual(['first', 'second'])
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]?.slice(0, 2)).toEqual([
      'job/follow',
      { args: { request: { jobId: 'job-1' } } },
    ])
  })
})

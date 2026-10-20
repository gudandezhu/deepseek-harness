/** The Host relays worker notifications and waterfalls into the browser event stream. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { TypertRemoteEventDispatch, TypertRemoteEventInvocation } from '@deepseek-ai/dsh-api-gateway'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionWorkerHandle } from '@deepseek-ai/dsh-session-worker-supervisor'
import { SessionWorkerEvents } from '../src/events.ts'

const sessionId = 'session-events' as SessionId
const agentId = 'agent-events'
const contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts.splice(0)) { void ctx.fiber.dispose() }
})

/** Producer-driven `$events` stream; the test pushes worker frames. */
class FakeStream {
  private readonly values: unknown[] = []
  private wake: (() => void) | undefined
  private done = false

  push(value: unknown): void {
    this.values.push(value)
    this.wake?.()
    this.wake = undefined
  }

  cancel(): Promise<unknown> {
    this.done = true
    this.wake?.()
    this.wake = undefined
    return Promise.resolve({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        while (this.values.length === 0 && !this.done) {
          await new Promise<void>((resolve) => { this.wake = resolve })
        }
        if (this.values.length > 0) return { done: false, value: this.values.shift() }
        return { done: true, value: undefined }
      },
    }
  }
}

class FakeWorker {
  readonly pid = 4242
  readonly sessionId = sessionId
  readonly calls: { endpoint: string; payload: unknown }[] = []
  readonly stream = new FakeStream()
  readonly open = vi.fn(() => this.stream)
  private exit!: () => void
  readonly exited = new Promise<void>((resolve) => { this.exit = resolve })

  async call(endpoint: string, payload: unknown): Promise<ConnectionRpcResult<unknown>> {
    this.calls.push({ endpoint, payload })
    return { ok: true, value: undefined }
  }

  terminate(): void {
    this.exit()
    void this.stream.cancel()
  }
}

function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  const events = new SessionWorkerEvents(ctx)
  const worker = new FakeWorker()
  const listener = vi.fn<(dispatch: TypertRemoteEventDispatch) => void>()
  events.attach(sessionId, worker as unknown as SessionWorkerHandle)
  return { events, worker, listener }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('Session worker event relay', () => {
  it('opens the worker event stream only while a browser source is subscribed', async () => {
    const { events, worker } = setup()
    expect(worker.open).not.toHaveBeenCalled()
    const dispose = events.onEvent(() => {})
    expect(worker.open).toHaveBeenCalledWith('$events', {})
    dispose()
    await settle()
  })

  it('forwards a worker notification with the allowlist resource readers', async () => {
    const { events, worker, listener } = setup()
    events.onEvent(listener)
    worker.stream.push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    worker.stream.push({ type: 'emit', event: 'api-session/status', args: [sessionId, true] })
    await settle()
    const dispatch = listener.mock.calls[0]?.[0]
    expect(dispatch).toMatchObject({ event: 'api-session/status', args: [sessionId, true] })
    if (dispatch === undefined || 'context' in dispatch) throw new Error('expected an emit dispatch')
    expect(typeof dispatch.resources?.['session']).toBe('function')
  })

  it('round-trips a worker waterfall answer through $events/result', async () => {
    const { events, worker, listener } = setup()
    events.onEvent(listener)
    worker.stream.push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    worker.stream.push({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'event-1',
      agentId,
      request: { tool: 'shell', command: 'ls' },
    })
    await settle()
    const invocation = listener.mock.calls[0]?.[0] as TypertRemoteEventInvocation
    expect(invocation).toBeDefined()
    expect(invocation.context.agentId).toBe(agentId)
    expect(invocation.request).toMatchObject({ tool: 'shell', command: 'ls' })

    invocation.resolve({ kind: 'result', value: { approved: true } })
    expect(worker.calls).toEqual([{
      endpoint: '$events/result',
      payload: {
        clientId: 'client-1',
        eventId: 'event-1',
        outcome: { kind: 'result', value: { approved: true } },
      },
    }])
  })

  it('sends a client rejection back to the worker', async () => {
    const { events, worker, listener } = setup()
    events.onEvent(listener)
    worker.stream.push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    worker.stream.push({
      type: 'waterfall', event: 'user-questions/request', eventId: 'event-2', agentId, request: {},
    })
    await settle()
    const invocation = listener.mock.calls[0]?.[0] as TypertRemoteEventInvocation
    invocation.reject(new Error('browser closed'))
    expect(worker.calls[0]?.payload).toMatchObject({
      clientId: 'client-1',
      eventId: 'event-2',
      outcome: { kind: 'rejected', error: { name: 'Error', message: 'browser closed' } },
    })
  })

  it('rejects a pending waterfall when the worker exits', async () => {
    const { events, worker, listener } = setup()
    events.onEvent(listener)
    worker.stream.push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    worker.stream.push({
      type: 'waterfall', event: 'approval/request', eventId: 'event-3', agentId, request: {},
    })
    await settle()
    const invocation = listener.mock.calls[0]?.[0] as TypertRemoteEventInvocation
    worker.terminate()
    await settle()
    expect(invocation.context.lifetime?.aborted).toBe(true)
  })

  it('cancels a pending waterfall when the worker sends a cancel frame', async () => {
    const { events, worker, listener } = setup()
    events.onEvent(listener)
    worker.stream.push({ type: 'ready', clientId: 'client-1', host: { home: '/home' } })
    worker.stream.push({
      type: 'waterfall', event: 'approval/request', eventId: 'event-4', agentId, request: {},
    })
    await settle()
    const invocation = listener.mock.calls[0]?.[0] as TypertRemoteEventInvocation
    worker.stream.push({ type: 'cancel', eventId: 'event-4' })
    await settle()
    expect(invocation.context.lifetime?.aborted).toBe(true)
  })
})

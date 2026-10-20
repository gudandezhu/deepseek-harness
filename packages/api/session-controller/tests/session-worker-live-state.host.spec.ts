/** Host live state folds worker follow and control frames into one browser window. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionWorkerLives,
  type SessionWorkerStreamTransport,
  type SessionWorkerTransport,
} from '../src/session-worker/live-state.ts'
import type { SessionSummary } from '../src/types.ts'

const sessionId = 'session-live' as SessionId

const contexts: Context[] = []

afterEach(() => {
  for (const ctx of contexts.splice(0)) { void ctx.fiber.dispose() }
})

function hostContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** Single-consumer stream whose producer is the test. */
class FakeStream implements SessionWorkerStreamTransport {
  private readonly values: unknown[] = []
  private wake: (() => void) | undefined
  private done = false

  push(value: unknown): void {
    this.values.push(value)
    this.wake?.()
    this.wake = undefined
  }

  end(): void {
    this.done = true
    this.wake?.()
    this.wake = undefined
  }

  cancel(): Promise<unknown> {
    this.end()
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

class FakeWorker implements SessionWorkerTransport {
  readonly pid = 12_345
  readonly streams = new Map<string, FakeStream[]>()
  private exit!: () => void
  readonly exited = new Promise<void>((resolve) => { this.exit = resolve })

  open(endpoint: string): SessionWorkerStreamTransport {
    const stream = new FakeStream()
    const list = this.streams.get(endpoint) ?? []
    list.push(stream)
    this.streams.set(endpoint, list)
    return stream
  }

  emit(endpoint: string, value: unknown): void {
    this.streams.get(endpoint)?.at(-1)?.push(value)
  }

  terminate(): void {
    this.exit()
    for (const list of this.streams.values()) {
      for (const stream of list) stream.end()
    }
  }
}

function header(): Record<string, unknown> {
  return { version: 1, id: sessionId, createdAt: 100, cwd: '/repo', isSeeded: false }
}

function event(seq: number, type = 'user/message'): SessionEvent {
  return { seq, time: seq, type, data: {} } as unknown as SessionEvent
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('Session worker live state', () => {
  it('folds an opening snapshot, live events, Assistant frames, and projections', async () => {
    const ctx = hostContext()
    const lives = new SessionWorkerLives(ctx)
    const events = vi.fn()
    const assistant = vi.fn()
    const projections = vi.fn()
    const generations = vi.fn()
    lives.observe({ event: events, assistant, projection: projections, generation: generations })
    const worker = new FakeWorker()

    lives.attach(sessionId, worker)
    worker.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 9,
      records: [
        { type: 'event', event: event(8) },
        { type: 'event', event: event(9, 'assistant/message') },
      ],
      hasMore: true,
      projections: { asOfSeq: 9, values: { title: 'first' } },
      assistantStream: { revision: 3 },
    })
    await settle()

    expect(lives.view(sessionId)).toMatchObject({
      baseSeq: 8,
      cursor: 9,
      hasMore: true,
      projections: { asOfSeq: 9, values: { title: 'first' } },
      assistantStream: { revision: 3 },
      generation: 1,
      agentAvailable: true,
    })
    expect(generations).toHaveBeenCalledWith(sessionId)

    worker.emit('session/follow', { type: 'event', event: event(10, 'turn/start') })
    worker.emit('session/follow', {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'attempt-1', revision: 4, startedAfterSeq: 10, turn: 1, step: 1 },
    })
    await settle()
    expect(lives.view(sessionId)?.events.map(entry => entry.seq)).toEqual([8, 9, 10])
    expect(lives.view(sessionId)?.running).toBe(true)
    expect(events).toHaveBeenCalledOnce()
    expect(assistant).toHaveBeenCalledOnce()

    worker.emit('session/control', {
      type: 'baseline',
      value: { projections: { [sessionId]: { asOfSeq: 10, values: { title: 'second' } } } },
    })
    worker.emit('session/control', { type: 'projection', sessionId, key: 'title', value: 'third', seq: 11 })
    await settle()
    expect(projections).toHaveBeenCalledWith({ sessionId, key: 'title', value: 'second', seq: 10 })
    expect(projections).toHaveBeenCalledWith({ sessionId, key: 'title', value: 'third', seq: 11 })
    expect(lives.projectionBaselines()[sessionId]).toEqual({ asOfSeq: 11, values: { title: 'third' } })
  })

  it('keeps a cold list row live and adds Sessions that persistence has not seen', async () => {
    const ctx = hostContext()
    const lives = new SessionWorkerLives(ctx)
    const worker = new FakeWorker()
    lives.attach(sessionId, worker)
    worker.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 2,
      records: [
        { type: 'event', event: event(1, 'turn/start') },
        { type: 'event', event: event(2, 'assistant/message') },
      ],
      hasMore: false,
      projections: { asOfSeq: 2, values: { title: 'live' } },
      assistantStream: { revision: 0 },
    })
    worker.emit('session/control', {
      type: 'baseline',
      value: { projections: { [sessionId]: { asOfSeq: 2, values: { title: 'live' } } } },
    })
    await settle()

    const cold: SessionSummary = {
      sessionId, updatedAt: 1, agentAvailable: false, running: false, blank: true,
    }
    expect(lives.overlay([cold])).toEqual([{
      ...cold,
      agentAvailable: true,
      projections: { kind: 'sequenced', asOfSeq: 2, values: { title: 'live' } },
    }])
    expect(lives.overlay([])).toEqual([{
      sessionId,
      updatedAt: 100,
      agentAvailable: true,
      running: false,
      blank: false,
      formatStatus: 'current',
      cwd: '/repo',
      projections: { kind: 'sequenced', asOfSeq: 2, values: { title: 'live' } },
    }])
  })

  it('publishes a fresh generation when a new worker reattaches and marks exit unavailable', async () => {
    const ctx = hostContext()
    const lives = new SessionWorkerLives(ctx)
    const generations = vi.fn()
    lives.observe({ event: () => {}, assistant: () => {}, projection: () => {}, generation: generations })
    const first = new FakeWorker()
    lives.attach(sessionId, first)
    first.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 1,
      records: [{ type: 'event', event: event(1) }],
      hasMore: false,
      projections: { asOfSeq: 1, values: {} },
      assistantStream: { revision: 0 },
    })
    await settle()
    expect(lives.view(sessionId)?.generation).toBe(1)

    const second = new FakeWorker()
    lives.attach(sessionId, second)
    second.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 4,
      records: [{ type: 'event', event: event(4) }],
      hasMore: false,
      projections: { asOfSeq: 4, values: {} },
      assistantStream: { revision: 0 },
    })
    await settle()
    expect(lives.view(sessionId)).toMatchObject({ generation: 2, cursor: 4, baseSeq: 4 })
    expect(generations).toHaveBeenCalledTimes(2)

    second.terminate()
    await settle()
    expect(lives.view(sessionId)?.agentAvailable).toBe(false)
  })

  it('bounds the retained event ring while reporting a dropped prefix', async () => {
    const ctx = hostContext()
    const lives = new SessionWorkerLives(ctx, 2)
    const worker = new FakeWorker()
    lives.attach(sessionId, worker)
    worker.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 2,
      records: [
        { type: 'event', event: event(1) },
        { type: 'event', event: event(2) },
      ],
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
      assistantStream: { revision: 0 },
    })
    for (let seq = 3; seq <= 6; seq += 1) worker.emit('session/follow', { type: 'event', event: event(seq) })
    await settle()
    const view = lives.view(sessionId)
    expect(view?.events.map(entry => entry.seq)).toEqual([5, 6])
    expect(view?.hasMore).toBe(true)
  })

  it('caps projected values per Session and keeps later keys out', async () => {
    const ctx = hostContext()
    const lives = new SessionWorkerLives(ctx, 4_096, { projectionLimit: 2 })
    const worker = new FakeWorker()
    lives.attach(sessionId, worker)
    worker.emit('session/follow', {
      type: 'snapshot',
      header: header(),
      cursor: 0,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
      assistantStream: { revision: 0 },
    })
    worker.emit('session/control', {
      type: 'baseline',
      value: { projections: { [sessionId]: { asOfSeq: 1, values: { a: 1, b: 2, c: 3 } } } },
    })
    await settle()
    expect(lives.view(sessionId)?.projections.values).toEqual({ a: 1, b: 2 })

    worker.emit('session/control', { type: 'projection', sessionId, key: 'd', value: 4, seq: 2 })
    await settle()
    expect(lives.view(sessionId)?.projections.values).toEqual({ a: 1, b: 2 })
  })

  it('evicts a cold Session after its TTL', async () => {
    vi.useFakeTimers()
    try {
      const ctx = hostContext()
      const lives = new SessionWorkerLives(ctx, 4_096, { coldTtlMs: 1_000 })
      const worker = new FakeWorker()
      lives.attach(sessionId, worker)
      worker.terminate()
      await settle()
      expect(lives.has(sessionId)).toBe(true)
      vi.advanceTimersByTime(1_000)
      expect(lives.has(sessionId)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts the least recently touched cold Sessions beyond the cap', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const ctx = hostContext()
      const lives = new SessionWorkerLives(ctx, 4_096, { coldTtlMs: 0, maxColdSessions: 2 })
      const ids = ['cold-a', 'cold-b', 'cold-c'] as SessionId[]
      const workers = ids.map(() => new FakeWorker())
      ids.forEach((id, index) => { lives.attach(id, workers[index] as FakeWorker) })
      for (const worker of workers) {
        vi.setSystemTime(Date.now() + 1)
        worker.terminate()
        await settle()
      }
      expect(lives.has(ids[0] as SessionId)).toBe(false)
      expect(lives.has(ids[1] as SessionId)).toBe(true)
      expect(lives.has(ids[2] as SessionId)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

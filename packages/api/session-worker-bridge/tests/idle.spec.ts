import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WorkerIdleTracker } from '../src/idle.ts'

function contextWith(sessionTitle?: { isBusy(): boolean }): Context {
  const ctx = new Context()
  ctx.provide('agents', { list: () => [] })
  if (sessionTitle !== undefined) ctx.provide('sessionTitle', sessionTitle)
  return ctx
}

describe('WorkerIdleTracker', () => {
  it('stays busy while a Session title call is running', async () => {
    let busy = true
    const tracker = new WorkerIdleTracker(contextWith({ isBusy: () => busy }), 0)

    expect(await tracker.inspect()).toEqual({ idle: false, reason: 'title-running' })

    busy = false
    expect(await tracker.inspect()).toEqual({ idle: true, reason: 'quiet' })
  })

  it('reports idle when the worker mounts no title service', async () => {
    const tracker = new WorkerIdleTracker(contextWith(), 0)

    expect(await tracker.inspect()).toEqual({ idle: true, reason: 'quiet' })
  })
})

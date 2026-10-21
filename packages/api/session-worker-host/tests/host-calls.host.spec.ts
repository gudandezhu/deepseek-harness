/** The Host answers a worker's Schedule calls with its own service. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ScheduleInputError } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SCHEDULE_HOST_SERVICE,
  SCHEDULE_INPUT_ERROR_CODE,
} from '@deepseek-ai/dsh-session-worker-protocol'
import type {
  SessionWorkerHostCallHandler,
  SessionWorkerSupervisor,
} from '@deepseek-ai/dsh-session-worker-supervisor'
import { registerHostCalls } from '../src/host-calls.ts'

const sessionId = 'session-1' as SessionId
const signal = new AbortController().signal

function setup(schedule: Record<string, unknown>) {
  const ctx = new Context()
  ctx.provide('schedule', schedule as never)
  const handlers = new Map<string, SessionWorkerHostCallHandler>()
  const supervisor = {
    registerHostCallHandler: vi.fn((service: string, registered: SessionWorkerHostCallHandler) => {
      handlers.set(service, registered)
      return () => {}
    }),
  } as unknown as SessionWorkerSupervisor
  registerHostCalls(ctx, supervisor)
  const handler = handlers.get(SCHEDULE_HOST_SERVICE)
  if (handler === undefined) throw new Error('handler was not registered')
  return handler
}

describe('Host reverse calls', () => {
  it('answers a list call with the Host Schedule service', async () => {
    const list = vi.fn(async () => [{ id: 'task-1' }])
    const call = setup({ list, catalog: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn() })
    await expect(call(sessionId, 'list', { request: { sessionId } }, signal))
      .resolves.toEqual({ ok: true, value: [{ id: 'task-1' }] })
    expect(list).toHaveBeenCalledWith({ sessionId })
  })

  it('refuses another Session and maps Schedule input failures', async () => {
    const schedule = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => { throw new ScheduleInputError('invalid_rule', 'bad rule') }),
      catalog: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    }
    const call = setup(schedule)
    await expect(call(sessionId, 'list', { request: { sessionId: 'session-2' } }, signal))
      .resolves.toMatchObject({ ok: false, error: { code: SCHEDULE_INPUT_ERROR_CODE } })
    await expect(call(sessionId, 'create', {
      sessionId,
      request: { prompt: 'p', title: 't', after_seconds: 60 },
    }, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: SCHEDULE_INPUT_ERROR_CODE, details: { code: 'invalid_rule' } },
    })
  })

  it('reports an unknown method without touching the service', async () => {
    const schedule = { list: vi.fn(), catalog: vi.fn(), create: vi.fn(), delete: vi.fn(), update: vi.fn() }
    const call = setup(schedule)
    await expect(call(sessionId, 'explode', {}, signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'session-worker/unknown-host-method' } })
    expect(schedule.list).not.toHaveBeenCalled()
  })
})

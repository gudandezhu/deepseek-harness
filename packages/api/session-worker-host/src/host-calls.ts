/**
 * Host-owned services a session worker may call back into.
 *
 * Schedule keeps one store and one timer in the Host. A worker's Schedule tool
 * forwards each management call here over the control channel, and this module
 * answers with the same values the in-process service returns.
 *
 * @module @deepseek-ai/dsh-session-worker-host/host-calls
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import {
  ScheduleId,
  ScheduleInputError,
  type ScheduleCreateRequest,
  type ScheduleDeleteRequest,
  type ScheduleService,
  type ScheduleUpdateRequest,
} from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  CORDIS_INSPECT_HOST_SERVICE,
  SCHEDULE_HOST_SERVICE,
  SCHEDULE_INPUT_ERROR_CODE,
} from '@deepseek-ai/dsh-session-worker-protocol'
import type { SessionWorkerSupervisor } from '@deepseek-ai/dsh-session-worker-supervisor'

/**
 * Publish the Host's Schedule service to every worker.
 * @param ctx - Host context carrying the Schedule service.
 * @param supervisor - worker owner whose reverse-call service routes handlers.
 */
export function registerHostCalls(ctx: Context, supervisor: SessionWorkerSupervisor): void {
  supervisor.registerHostCallHandler(
    SCHEDULE_HOST_SERVICE,
    async (sessionId, method, payload, signal) => {
      const schedule = ctx.get('schedule')
      if (schedule === undefined) {
        return failure(
          'session-worker/host-service-unavailable',
          'Host mounts no schedule service',
        )
      }
      if (!SCHEDULE_METHODS.has(method)) {
        return failure(
          'session-worker/unknown-host-method',
          `unknown schedule method ${JSON.stringify(method)}`,
        )
      }
      try {
        return { ok: true, value: await dispatchSchedule(schedule, sessionId, method, payload, signal) }
      } catch (error) {
        if (error instanceof ScheduleInputError) {
          return {
            ok: false,
            error: {
              code: SCHEDULE_INPUT_ERROR_CODE,
              message: error.message,
              details: { code: error.code },
            },
          }
        }
        return failure(
          'session-worker/host-call-failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    },
  )
  supervisor.registerHostCallHandler(
    CORDIS_INSPECT_HOST_SERVICE,
    (_sessionId, method) => {
      const registry = ctx.get('cordisInspect')
      if (registry === undefined) {
        return Promise.resolve(failure(
          'session-worker/host-service-unavailable',
          'Host mounts no Cordis inspect registry',
        ))
      }
      if (method === 'client-manifest') {
        return Promise.resolve<ConnectionRpcResult<unknown>>({ ok: true, value: registry.clientProviders() })
      }
      return Promise.resolve(failure(
        'session-worker/unknown-host-method',
        `unknown cordisInspect method ${JSON.stringify(method)}`,
      ))
    },
  )
}

async function dispatchSchedule(
  schedule: ScheduleService,
  sessionId: SessionId,
  method: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const fields = recordOf(payload)
  switch (method) {
    case 'create': {
      const owner = readSessionId(fields, 'sessionId')
      assertOwner(owner, sessionId)
      return schedule.create(owner, readCreateRequest(readRecord(fields, 'request')), signal)
    }
    case 'list': {
      const request = readRecord(fields, 'request')
      const owner = readSessionId(request, 'sessionId')
      assertOwner(owner, sessionId)
      return schedule.list({ sessionId: owner })
    }
    case 'catalog':
      return schedule.catalog()
    case 'delete': {
      const request = readRecord(fields, 'request')
      assertOwner(readSessionId(request, 'sessionId'), sessionId)
      return schedule.delete(readDeleteRequest(request), signal)
    }
    case 'update': {
      const request = readRecord(fields, 'request')
      assertOwner(readSessionId(request, 'sessionId'), sessionId)
      return schedule.update(readUpdateRequest(request), signal)
    }
    default:
      throw new Error(`session-worker: unreachable schedule method ${JSON.stringify(method)}`)
  }
}

const SCHEDULE_METHODS: ReadonlySet<string> = new Set(['create', 'list', 'catalog', 'delete', 'update'])

/** A worker may manage only the Session it owns. */
function assertOwner(owner: SessionId, sessionId: SessionId): void {
  if (owner !== sessionId) {
    throw new ScheduleInputError(
      'invalid_selector',
      `schedule call names session "${owner}", which this worker does not own`,
    )
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleInputError('invalid_selector', 'schedule call payload must be an object')
  }
  return value as Record<string, unknown>
}

function readRecord(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  return recordOf(record[field])
}

function readSessionId(record: Record<string, unknown>, field: string): SessionId {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScheduleInputError('invalid_selector', `schedule call ${field} must be a session id`)
  }
  return value as SessionId
}

function readCreateRequest(request: Record<string, unknown>): ScheduleCreateRequest {
  return {
    prompt: readText(request, 'prompt'),
    title: readText(request, 'title'),
    ...(request['after_seconds'] === undefined
      ? {}
      : { after_seconds: readNumber(request, 'after_seconds') }),
    ...(request['at'] === undefined ? {} : { at: request['at'] as NonNullable<ScheduleCreateRequest['at']> }),
    ...(request['every_seconds'] === undefined
      ? {}
      : { every_seconds: readNumber(request, 'every_seconds') }),
    ...(request['daily'] === undefined
      ? {}
      : { daily: request['daily'] as NonNullable<ScheduleCreateRequest['daily']> }),
    ...(request['weekly'] === undefined
      ? {}
      : { weekly: request['weekly'] as NonNullable<ScheduleCreateRequest['weekly']> }),
    ...(request['cron'] === undefined
      ? {}
      : { cron: request['cron'] as NonNullable<ScheduleCreateRequest['cron']> }),
  }
}

function readDeleteRequest(request: Record<string, unknown>): ScheduleDeleteRequest {
  return {
    sessionId: readSessionId(request, 'sessionId'),
    id: ScheduleId(readText(request, 'id')),
  }
}

function readUpdateRequest(request: Record<string, unknown>): ScheduleUpdateRequest {
  return {
    ...readDeleteRequest(request),
    ...(request['title'] === undefined ? {} : { title: readText(request, 'title') }),
    ...(request['prompt'] === undefined ? {} : { prompt: readText(request, 'prompt') }),
    expected: request['expected'] as ScheduleUpdateRequest['expected'],
    ...(request['change'] === undefined
      ? {}
      : { change: request['change'] as NonNullable<ScheduleUpdateRequest['change']> }),
  }
}

function readText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') {
    throw new ScheduleInputError('invalid_selector', `schedule call ${field} must be a string`)
  }
  return value
}

function readNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number') {
    throw new ScheduleInputError('invalid_selector', `schedule call ${field} must be a number`)
  }
  return value
}

function failure(code: string, message: string): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

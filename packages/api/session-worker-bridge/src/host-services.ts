/**
 * Worker-side proxies for services the Host owns.
 *
 * A worker mounts its own Agent, and some preset tools read services that must
 * keep one owner in the Host process (Schedule's store and timers do). This
 * plugin provides the same service names in the worker, forwarding each call
 * through the bridge's reverse-call channel.
 *
 * @module @deepseek-ai/dsh-session-worker-bridge/host-services
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcFailure } from '@deepseek-ai/dsh-client-connection'
import {
  CordisInspectRegistryService,
  type CordisInspectProviderManifest,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { ScheduleInputError, type ScheduleService } from '@deepseek-ai/dsh-schedule'
import {
  CORDIS_INSPECT_HOST_SERVICE,
  SCHEDULE_HOST_SERVICE,
  SCHEDULE_INPUT_ERROR_CODE,
} from '@deepseek-ai/dsh-session-worker-protocol'
import z from '@deepseek-ai/schemastery'
import type { SessionWorkerHostCalls } from './index.ts'

/** Stable Cordis plugin name. */
export const name = 'session-worker-host-services'

/** The bridge must publish its reverse-call face first. */
export const inject = ['sessionWorkerHostCalls']

/** Host-service proxy policy. */
export interface Config {
  /** Milliseconds a Client inspect query may wait for a browser answer. */
  readonly clientInspectTimeoutMs?: number
}

/** Default wait for a browser-supplied Client inspect answer. */
const DEFAULT_CLIENT_INSPECT_TIMEOUT_MS = 30_000

/** Environment entry carrying the advertised Web GUI URL from the Host. */
const WEB_URL_ENV = 'DSH_WEB_URL'

/** Plugin configuration schema. */
export const Config = z.object({
  clientInspectTimeoutMs: z.natural().min(1).default(DEFAULT_CLIENT_INSPECT_TIMEOUT_MS),
})

/** The Schedule methods a preset tool may call. */
type ScheduleProxy = Pick<ScheduleService, 'create' | 'list' | 'catalog' | 'delete' | 'update'>

interface ResolvedConfig {
  readonly clientInspectTimeoutMs: number
}

/**
 * Mount the host-service proxies.
 * @param ctx - worker tree context carrying the bridge callback face.
 * @param config - inspect query limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    clientInspectTimeoutMs: config.clientInspectTimeoutMs ?? DEFAULT_CLIENT_INSPECT_TIMEOUT_MS,
  }
  const calls = ctx.sessionWorkerHostCalls
  const schedule: ScheduleProxy = {
    create: (sessionId, request, signal) => invoke(calls, 'create', { sessionId, request }, signal),
    list: request => invoke(calls, 'list', { request }),
    catalog: () => invoke(calls, 'catalog', {}),
    delete: (request, signal) => invoke(calls, 'delete', { request }, signal),
    update: (request, signal) => invoke(calls, 'update', { request }, signal),
  }
  ctx.provide('schedule', schedule)

  // `harness-dev-context` injects `webApp`; the Host supplies the same URL the
  // browser uses, so the worker's prompt matches the single-process one.
  const webUrl = process.env[WEB_URL_ENV]
  if (webUrl !== undefined) {
    ctx.provide('webApp', { getAdvertisedUrl: () => webUrl })
  }

  ctx.plugin(CordisInspectRegistryService, resolved.clientInspectTimeoutMs)
  ctx.inject(['cordisInspect'], (inspectCtx) => {
    void syncClientManifest(inspectCtx, calls)
  })
}

/**
 * Mirror the Host's Client inspect provider directory into the worker registry.
 * @param ctx - context carrying the worker's own `cordisInspect` registry.
 * @param calls - bridge reverse-call face.
 */
async function syncClientManifest(ctx: Context, calls: SessionWorkerHostCalls): Promise<void> {
  const result = await calls.call(CORDIS_INSPECT_HOST_SERVICE, 'client-manifest', {})
  if (!result.ok || !Array.isArray(result.value)) return
  ctx.get('cordisInspect')?.syncClientManifest(result.value as CordisInspectProviderManifest[])
}

/**
 * Forward one Schedule call and unwrap the Host's result.
 * @param calls - bridge reverse-call face.
 * @param method - Schedule method name.
 * @param payload - method payload.
 * @param signal - optional cancellation of the local wait.
 * @returns the Host service's own value.
 */
async function invoke<T>(
  calls: SessionWorkerHostCalls,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const result = await calls.call(SCHEDULE_HOST_SERVICE, method, payload, signal)
  // The Host handler answers in ScheduleService's return types; this channel is
  // the same installation on both ends.
  if (result.ok) return result.value as T
  throw scheduleError(method, result.error)
}

function scheduleError(method: string, failure: ConnectionRpcFailure): Error {
  if (failure.code === SCHEDULE_INPUT_ERROR_CODE) {
    const code = scheduleInputCode(failure.details)
    return new ScheduleInputError(code, failure.message)
  }
  return new Error(`schedule ${method} failed: ${failure.message}`)
}

type ScheduleInputCode = ConstructorParameters<typeof ScheduleInputError>[0]

const SCHEDULE_INPUT_CODES: ReadonlySet<string> = new Set<ScheduleInputCode>([
  'invalid_prompt',
  'invalid_selector',
  'invalid_rule',
  'invalid_time_zone',
  'not_future',
  'time_out_of_range',
  'frequency_too_high',
  'subagent_session',
])

function scheduleInputCode(details: object): ScheduleInputCode {
  const code = (details as { readonly code?: unknown }).code
  return typeof code === 'string' && SCHEDULE_INPUT_CODES.has(code)
    ? code as ScheduleInputCode
    : 'invalid_rule'
}

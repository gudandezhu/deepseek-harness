/**
 * Host plugin that moves Session Agent work into per-session worker processes.
 *
 * The plugin owns three pieces of host state and nothing else: the worker
 * supervisor, the endpoint router consulted by the Gateway, and the live
 * Session cache that keeps browser streams alive across worker generations.
 * Opening a Session never spawns a worker; the first routed write does.
 *
 * @module @deepseek-ai/dsh-session-worker-host
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { INHERITED_PROFILE_PATCH_ENV } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace/types'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_COLD_SESSION_TTL_MS,
  DEFAULT_LIVE_EVENT_LIMIT,
  DEFAULT_LIVE_PROJECTION_LIMIT,
  DEFAULT_MAX_COLD_SESSIONS,
  SessionWorkerLives,
} from '@deepseek-ai/dsh-api-session-controller'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_WORKER_PROFILE,
  SessionWorkerSupervisor,
} from '@deepseek-ai/dsh-session-worker-supervisor'
import { DEFAULT_FORWARDED_ENV, forwardedEnvironment, hostWorkerCommand, inheritedPatchArgs } from './command.ts'
import { SessionWorkerEvents } from './events.ts'
import { registerHostCalls } from './host-calls.ts'
import { SessionWorkerRouter } from './router.ts'

export {
  DEFAULT_FORWARDED_ENV,
  electronWorkerCommand,
  forwardedEnvironment,
  hostWorkerCommand,
  inheritedPatchArgs,
  sharedNodeFlags,
  workerCommand,
} from './command.ts'
export type { HostWorkerCommandInput } from './command.ts'
export { SessionWorkerEvents } from './events.ts'
export { SessionWorkerRouter } from './router.ts'

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A session worker is inside a turn for this Session. */
    'session-worker': true
  }
}

/** Stable Cordis plugin name. */
export const name = 'session-worker-host'

/** Environment override for the idle reclaim delay, used by benchmarks. */
export const IDLE_TIMEOUT_ENV = 'DSH_SESSION_WORKER_IDLE_MS'

/** Host plugin configuration. */
export interface Config {
  /** Executable and fixed arguments that boot a worker, e.g. `['dsh']`. */
  readonly command?: string[]
  /** Shipped profile that mounts the worker composition. */
  readonly profile?: string
  /** Extra worker arguments; defaults to the Host's `--patch` overlays. */
  readonly args?: string[]
  /** Explicit child environment entries merged after the forwarded environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Exact names or `prefix*` patterns the worker inherits from the Host environment. */
  readonly forwardEnv?: string[]
  /** Milliseconds an idle worker may live; `0` disables automatic shutdown. */
  readonly idleTimeoutMs?: number
  /** Milliseconds allowed for spawn, ready, and initialize. */
  readonly readyTimeoutMs?: number
  /** Milliseconds allowed for shutdown acknowledgement and exit. */
  readonly shutdownTimeoutMs?: number
  /** Milliseconds the subprocess provider may spend terminating a range. */
  readonly graceMs?: number
  /** Retained live events per Session. */
  readonly liveEventLimit?: number
  /** Retained projection values per Session. */
  readonly projectionLimit?: number
  /** Milliseconds a Session with no worker stays cached; `0` keeps it. */
  readonly coldSessionTtlMs?: number
  /** Cold Sessions retained before the least recently touched is evicted. */
  readonly maxColdSessions?: number
}

/** Cordis plugin configuration schema. */
export const Config: z<Config> = z.object({
  command: z.array(String),
  profile: z.string().default(DEFAULT_WORKER_PROFILE),
  args: z.array(String),
  env: z.dict(z.string()).default({}),
  forwardEnv: z.array(String),
  idleTimeoutMs: z.natural().min(0),
  readyTimeoutMs: z.natural().min(1).default(DEFAULT_READY_TIMEOUT_MS),
  shutdownTimeoutMs: z.natural().min(1).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  graceMs: z.natural().min(1),
  liveEventLimit: z.natural().min(1).default(DEFAULT_LIVE_EVENT_LIMIT),
  projectionLimit: z.natural().min(1).default(DEFAULT_LIVE_PROJECTION_LIMIT),
  coldSessionTtlMs: z.natural().min(0).default(DEFAULT_COLD_SESSION_TTL_MS),
  maxColdSessions: z.natural().min(0).default(DEFAULT_MAX_COLD_SESSIONS),
})

/**
 * Mount the supervisor and publish the host-side router and live state.
 * @param ctx - host plugin context.
 * @param config - worker command and reclaim policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(ctx, config)
  const lives = new SessionWorkerLives(ctx, resolved.liveEventLimit, {
    projectionLimit: resolved.projectionLimit,
    coldTtlMs: resolved.coldSessionTtlMs,
    maxColdSessions: resolved.maxColdSessions,
  })
  ctx.provide('sessionWorkerLives', lives)
  const events = new SessionWorkerEvents(ctx)
  ctx.provide('sessionWorkerEventRelay', events)
  ctx.plugin(SessionWorkerSupervisor, {
    command: [...resolved.command],
    profile: resolved.profile,
    args: [...resolved.args],
    env: resolved.env,
    idleTimeoutMs: resolved.idleTimeoutMs,
    readyTimeoutMs: resolved.readyTimeoutMs,
    shutdownTimeoutMs: resolved.shutdownTimeoutMs,
    graceMs: resolved.graceMs,
  })
  ctx.inject(['sessionWorkers', 'remoteAccess'], (workerCtx) => {
    const supervisor = workerCtx.get('sessionWorkers')
    if (supervisor === undefined) return
    const router = new SessionWorkerRouter(workerCtx, supervisor, lives, events)
    ctx.provide('sessionWorkerRouter', router)
    registerHostCalls(workerCtx, supervisor)
    // Schedule delivery is an ordinary routed write; publishing the port keeps
    // the Schedule runtime from resolving a second Agent in the Host.
    ctx.provide('sessionReminderDelivery', router)
  })
  // Archive admission lives with the Workspace registry: report a running
  // worker turn so an archive without `stopActivity` is refused, and stop the
  // worker when the caller asks for that. An idle worker is not activity; it
  // reclaims itself.
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const activity = await next()
    return lives.view(sessionId)?.running === true
      ? [...activity, { kind: 'session-worker' }]
      : activity
  })
  ctx.on('workspace/session-stop', async ({ sessionId }) => {
    await ctx.get('sessionWorkers')?.shutdown(sessionId)
  })
  // A Settings or preset write reaches a worker only through its profile
  // patch at spawn. Reclaim idle workers so the next prompt composes from the
  // new patch; a running turn keeps its worker until it settles.
  ctx.on('settings/document-updated', () => {
    void ctx.get('sessionWorkers')?.shutdownIdleWorkers().catch((error: unknown) => {
      ctx.logger.warn('session-worker: reclaiming idle workers after a settings change failed', error)
    })
  })
}

interface ResolvedConfig {
  readonly command: readonly string[]
  readonly profile: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly idleTimeoutMs: number
  readonly readyTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly graceMs: number
  readonly liveEventLimit: number
  readonly projectionLimit: number
  readonly coldSessionTtlMs: number
  readonly maxColdSessions: number
}

/**
 * Derive the worker command from the process that hosts this plugin.
 * @returns the executable and fixed arguments, without a profile.
 */
function workerCommandForHost(): string[] {
  return hostWorkerCommand({
    electron: process.versions.electron !== undefined,
    execPath: process.execPath,
    execArgv: process.execArgv,
    entry: process.argv[1],
    runtimeDir: process.argv[2],
  })
}

/**
 * Environment that makes the Electron executable run the bundled CLI as Node.
 * @returns one entry under Electron, nothing otherwise.
 */
function electronEnvironment(): Record<string, string> {
  return process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }
}

function resolveConfig(ctx: Context, config: Config): ResolvedConfig {
  // The schema materializes an unspecified string array as `[]`, so an empty
  // value means "derive it" rather than "boot nothing".
  const command = config.command !== undefined && config.command.length > 0
    ? config.command
    : workerCommandForHost()
  const args = config.args !== undefined && config.args.length > 0
    ? config.args
    : inheritedPatchArgs(process.argv.slice(2))
  const forwardEnv = config.forwardEnv !== undefined && config.forwardEnv.length > 0
    ? config.forwardEnv
    : DEFAULT_FORWARDED_ENV
  // The subprocess scrub removes DSH_* and credential-shaped names, so the
  // deployment identity and any exported provider credential travel here.
  const env = {
    ...forwardedEnvironment(forwardEnv),
    ...electronEnvironment(),
    ...inheritedProfilePatch(ctx),
    ...config.env,
  }
  return {
    command,
    profile: config.profile ?? DEFAULT_WORKER_PROFILE,
    args,
    env,
    idleTimeoutMs: config.idleTimeoutMs ?? idleTimeoutFromEnvironment(),
    readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    liveEventLimit: config.liveEventLimit ?? DEFAULT_LIVE_EVENT_LIMIT,
    projectionLimit: config.projectionLimit ?? DEFAULT_LIVE_PROJECTION_LIMIT,
    coldSessionTtlMs: config.coldSessionTtlMs ?? DEFAULT_COLD_SESSION_TTL_MS,
    maxColdSessions: config.maxColdSessions ?? DEFAULT_MAX_COLD_SESSIONS,
  }
}

/**
 * Hand the Host profile patch to the worker so a preset or Settings edit made
 * under the web profile also composes the worker's agent.
 * @param ctx - Host context; profiles launched by `dsh` provide `profileContext`.
 * @returns the inherited-patch environment entry, or nothing without a patch file.
 */
function inheritedProfilePatch(ctx: Context): Record<string, string> {
  const profile = ctx.get('profileContext')
  if (profile === undefined || !existsSync(profile.patchPath)) return {}
  return { [INHERITED_PROFILE_PATCH_ENV]: profile.patchPath }
}

function idleTimeoutFromEnvironment(): number {
  const raw = process.env[IDLE_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`session-worker-host: ${IDLE_TIMEOUT_ENV} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

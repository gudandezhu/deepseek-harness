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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_LIVE_EVENT_LIMIT,
  SessionWorkerLives,
} from '@deepseek-ai/dsh-api-session-controller'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_WORKER_PROFILE,
  SessionWorkerSupervisor,
} from '@deepseek-ai/dsh-session-worker-supervisor'
import { DEFAULT_FORWARDED_ENV, forwardedEnvironment, inheritedPatchArgs, workerCommand } from './command.ts'
import { SessionWorkerRouter } from './router.ts'

export {
  DEFAULT_FORWARDED_ENV,
  forwardedEnvironment,
  inheritedPatchArgs,
  sharedNodeFlags,
  workerCommand,
} from './command.ts'
export { SessionWorkerRouter } from './router.ts'

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
})

/**
 * Mount the supervisor and publish the host-side router and live state.
 * @param ctx - host plugin context.
 * @param config - worker command and reclaim policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const lives = new SessionWorkerLives(ctx, resolved.liveEventLimit)
  ctx.provide('sessionWorkerLives', lives)
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
    ctx.provide('sessionWorkerRouter', new SessionWorkerRouter(workerCtx, supervisor, lives))
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
}

function resolveConfig(config: Config): ResolvedConfig {
  // The schema materializes an unspecified string array as `[]`, so an empty
  // value means "derive it" rather than "boot nothing".
  const command = config.command !== undefined && config.command.length > 0
    ? config.command
    : workerCommand(process.execPath, process.execArgv, process.argv[1])
  const args = config.args !== undefined && config.args.length > 0
    ? config.args
    : inheritedPatchArgs(process.argv.slice(2))
  const forwardEnv = config.forwardEnv !== undefined && config.forwardEnv.length > 0
    ? config.forwardEnv
    : DEFAULT_FORWARDED_ENV
  return {
    command,
    profile: config.profile ?? DEFAULT_WORKER_PROFILE,
    args,
    // The subprocess scrub removes DSH_* and credential-shaped names, so the
    // deployment identity and any exported provider credential travel here.
    env: { ...forwardedEnvironment(forwardEnv), ...config.env },
    idleTimeoutMs: config.idleTimeoutMs ?? idleTimeoutFromEnvironment(),
    readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    liveEventLimit: config.liveEventLimit ?? DEFAULT_LIVE_EVENT_LIMIT,
  }
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

/**
 * Host half of the per-session process boundary.
 *
 * One supervisor owns every `session-worker` child for a Host generation. It
 * spawns `dsh --profile session-worker` over `ctx.subprocess` with the
 * inherited fd 7 control channel, forwards unary Connection envelopes and
 * Gateway logical streams, receives `worker.idle`, runs the idle shutdown
 * timer, and joins the managed process range before allowing the same Session
 * to spawn again.
 *
 * Stage one deliberately implements no pooling or concurrency limits: every
 * Session that needs work gets its own worker, and several may run at once.
 *
 * @module @deepseek-ai/dsh-session-worker-supervisor
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ClientRequest,
  ConnectionRpcFailure,
  ConnectionRpcResult,
  ServerResponse,
} from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  AsyncQueue,
  SessionWorkerFrameDecoder,
  SESSION_WORKER_PROTOCOL_VERSION,
  asWorkerToHostFrame,
  decodeBody,
  encodeFrame,
  isPassiveStreamEndpoint,
  type WorkerHostCallFrame,
  type WorkerRpcErrorFrame,
  type WorkerToHostFrame,
  type WorkerUnaryResponseFrame,
  type HostToWorkerFrame,
} from '@deepseek-ai/dsh-session-worker-protocol'

export type { SessionId } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session worker process supervisor. */
    sessionWorkers: SessionWorkerSupervisor
  }
}

/** Default argv prefix that boots the worker profile. */
export const DEFAULT_WORKER_COMMAND: readonly string[] = ['dsh']

/** Default shipped profile name. */
export const DEFAULT_WORKER_PROFILE = 'session-worker'

/** Default idle delay before an idle worker is shut down. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/** Default bound for spawn plus initialize. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000

/** Default bound for shutdown acknowledgement and process exit. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

/** Default subprocess termination grace. */
export const DEFAULT_GRACE_MS = 5_000

/** Default maximum control frame size. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Default bound on buffered items for one logical stream direction. */
export const DEFAULT_STREAM_BUFFER_ITEMS = 1_024

/** Default retained diagnostic output per child stream. */
export const DEFAULT_CHILD_OUTPUT_BYTES = 64 * 1024

/** Supervisor deployment configuration. */
export interface Config {
  /** Executable and fixed arguments that boot the worker, e.g. `['dsh']`. */
  readonly command?: string[]
  /** Profile name appended as `--profile <name>`. */
  readonly profile?: string
  /** Extra arguments appended after the profile flags, e.g. `--patch` overlays. */
  readonly args?: string[]
  /** Working directory for the child; defaults to the supervisor's own. */
  readonly cwd?: string
  /** Explicit environment entries merged onto the scrubbed parent environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Milliseconds an idle worker may live; `0` disables automatic shutdown. */
  readonly idleTimeoutMs?: number
  /** Milliseconds allowed for spawn, ready, and initialize. */
  readonly readyTimeoutMs?: number
  /** Milliseconds allowed for shutdown acknowledgement and exit. */
  readonly shutdownTimeoutMs?: number
  /** Milliseconds the subprocess provider may spend terminating the range. */
  readonly graceMs?: number
  /** Maximum UTF-8 size of one control frame. */
  readonly maxFrameBytes?: number
  /** Maximum buffered items in either direction of one logical stream. */
  readonly streamBufferItems?: number
  /** Retained stdout/stderr bytes used in child diagnostics. */
  readonly outputBytes?: number
}

/** Fully resolved supervisor configuration. */
interface ResolvedConfig {
  readonly command: readonly string[]
  readonly profile: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly idleTimeoutMs: number
  readonly readyTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly graceMs: number
  readonly maxFrameBytes: number
  readonly streamBufferItems: number
  readonly outputBytes: number
}

/** Cordis plugin configuration schema. */
export const Config: z<Config> = z.object({
  command: z.array(String).default([...DEFAULT_WORKER_COMMAND]),
  profile: z.string().default(DEFAULT_WORKER_PROFILE),
  args: z.array(String).default([]),
  cwd: z.string(),
  env: z.dict(z.string()).default({}),
  idleTimeoutMs: z.natural().min(0).default(DEFAULT_IDLE_TIMEOUT_MS),
  readyTimeoutMs: z.natural().min(1).default(DEFAULT_READY_TIMEOUT_MS),
  shutdownTimeoutMs: z.natural().min(1).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  graceMs: z.natural().min(1).default(DEFAULT_GRACE_MS),
  maxFrameBytes: z.natural().min(1).default(DEFAULT_MAX_FRAME_BYTES),
  streamBufferItems: z.natural().min(1).default(DEFAULT_STREAM_BUFFER_ITEMS),
  outputBytes: z.natural().min(1).default(DEFAULT_CHILD_OUTPUT_BYTES),
})

/** Options accepted by one forwarded call. */
export interface WorkerCallOptions {
  /** Cancels the wait for a response; the worker may still finish the call. */
  readonly signal?: AbortSignal
}

/** Stable stream failure raised to a forwarded stream consumer. */
export class SessionWorkerStreamError extends Error {
  /**
   * @param failure - carrier failure fields reported by the worker.
   */
  constructor(readonly failure: ConnectionRpcFailure) {
    super(failure.message)
    this.name = 'SessionWorkerStreamError'
  }
}

/** Host-side handle for one worker process bound to one Session. */
export interface SessionWorkerHandle {
  /** Worker process id reported in the ready frame. */
  readonly pid: number
  /** Session bound to this worker; every forwarded call speaks for it. */
  readonly sessionId: SessionId
  /** Resolves after the managed process range is empty. */
  readonly exited: Promise<void>
  /** Current idle observation from the worker. */
  readonly idle: boolean
  /** Whether the process ended without a requested shutdown. */
  readonly crashed: boolean

  /**
   * Forward one unary Remote call.
   * @param endpoint - exact Remote endpoint such as `session.prompt`.
   * @param payload - JSON argument object.
   * @param options - optional cancellation of the local wait.
   * @returns the Connection result envelope.
   */
  call<T = unknown>(
    endpoint: string,
    payload: unknown,
    options?: WorkerCallOptions,
  ): Promise<ConnectionRpcResult<T>>

  /**
   * Open one forwarded logical stream.
   * @param endpoint - canonical Remote stream endpoint.
   * @param payload - wire stream payload.
   * @param options - optional cancellation for the whole stream.
   * @returns a single-consumer async iterable that cancels on early return.
   */
  open(endpoint: string, payload: unknown, options?: WorkerCallOptions): SessionWorkerStream

  /**
   * Wait until the worker reports idle.
   * @param timeoutMs - maximum wait; defaults to the ready timeout.
   * @returns true when idle was observed, false on timeout.
   */
  waitForIdle(timeoutMs?: number): Promise<boolean>

  /** Flush, dispose, and join the worker; idempotent. */
  shutdown(): Promise<void>
}

/** Host-side supervisor service (`ctx.sessionWorkers`). */
/**
 * One host-owned service method a worker may call back into.
 * @param sessionId - worker's bound Session, for ownership checks.
 * @param method - requested service method.
 * @param payload - caller payload.
 * @param signal - cancellation signalled when the worker dies.
 * @returns the unary result envelope returned to the worker.
 */
export type SessionWorkerHostCallHandler = (
  sessionId: SessionId,
  method: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult<unknown>>

export class SessionWorkerSupervisor extends Service {
  static inject = ['subprocess']

  /** Cordis configuration schema. */
  static Config: z<Config> = Config

  private readonly config: ResolvedConfig
  private readonly workers = new Map<SessionId, SessionWorkerConnection>()
  private readonly hostCallHandlers = new Map<string, SessionWorkerHostCallHandler>()
  private readonly acquiring = new Map<SessionId, Promise<SessionWorkerConnection>>()
  private readonly exiting = new Map<SessionId, Promise<void>>()
  private disposed = false

  /**
   * @param ctx - host context carrying `ctx.subprocess`.
   * @param config - command, environment, and timer policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionWorkers')
    this.config = resolveConfig(config)
    ctx.effect(() => () => this.stopAll(), 'session-worker-supervisor: live workers')
  }

  /**
   * Return the live worker for a Session or spawn one. A Session whose previous
   * worker is still exiting waits for that range to empty before spawning, so
   * the JSONL write lease transfers without conflict.
   * @param sessionId - ordinary Session identity.
   * @returns the ready worker handle.
   */
  async acquire(sessionId: SessionId): Promise<SessionWorkerHandle> {
    for (;;) {
      if (this.disposed) throw new Error('session-worker-supervisor: service is disposed')
      const live = this.workers.get(sessionId)
      if (live !== undefined) {
        if (!live.closing) return live
        await live.exited
        continue
      }
      const pending = this.acquiring.get(sessionId)
      if (pending !== undefined) return pending
      const exiting = this.exiting.get(sessionId)
      if (exiting !== undefined) {
        await exiting
        continue
      }
      const spawn = this.spawnWorker(sessionId)
      this.acquiring.set(sessionId, spawn)
      try {
        return await spawn
      } finally {
        if (this.acquiring.get(sessionId) === spawn) this.acquiring.delete(sessionId)
      }
    }
  }

  /**
   * Look up the live worker for a Session.
   * @param sessionId - Session identity.
   * @returns the worker, or undefined when none is bound.
   */
  get(sessionId: SessionId): SessionWorkerHandle | undefined {
    return this.workers.get(sessionId)
  }

  /**
   * Stop one Session's worker and wait for its managed range to empty.
   * @param sessionId - Session identity.
   */
  async shutdown(sessionId: SessionId): Promise<void> {
    const worker = this.workers.get(sessionId)
    if (worker !== undefined) await worker.shutdown()
  }

  /** Stop every live worker in parallel and wait for all ranges to empty. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map(worker => worker.shutdown()))
    this.workers.clear()
  }

  /**
   * Stop every worker currently reporting idle, leaving a running turn alone.
   * The next prompt spawns a worker from the current profile patch.
   */
  async shutdownIdleWorkers(): Promise<void> {
    const idle = [...this.workers.values()].filter(worker => worker.idle)
    await Promise.allSettled(idle.map(worker => worker.shutdown()))
  }

  /**
   * Publish a host-owned service the workers may call back into.
   * @param service - service name the worker sends.
   * @param handler - method dispatcher for that service.
   * @returns disposer for the registration.
   */
  registerHostCallHandler(service: string, handler: SessionWorkerHostCallHandler): () => void {
    this.hostCallHandlers.set(service, handler)
    return () => {
      if (this.hostCallHandlers.get(service) === handler) this.hostCallHandlers.delete(service)
    }
  }

  private async spawnWorker(sessionId: SessionId): Promise<SessionWorkerConnection> {
    const spec = {
      argv: [...this.config.command, '--profile', this.config.profile, ...this.config.args],
      cwd: this.config.cwd,
      stdio: {
        stdin: 'ignore' as const,
        stdout: { maxBytes: this.config.outputBytes },
        stderr: { maxBytes: this.config.outputBytes },
        control: 'pipe' as const,
      },
      graceMs: this.config.graceMs,
      env: { ...this.config.env },
    }
    let runtime: SubprocessRuntime
    try {
      runtime = this.ctx.subprocess
    } catch (error) {
      throw new Error('session-worker-supervisor: ctx.subprocess is unavailable', { cause: error })
    }
    const handle = runtime.spawn(spec)
    const worker = new SessionWorkerConnection(sessionId, handle, this.config, {
      onClosed: (closed) => {
        if (this.workers.get(sessionId) === closed) this.workers.delete(sessionId)
      },
      hostCall: service => this.hostCallHandlers.get(service),
    })
    this.workers.set(sessionId, worker)
    const exited = worker.exited.finally(() => {
      if (this.exiting.get(sessionId) === exited) this.exiting.delete(sessionId)
    })
    this.exiting.set(sessionId, exited)
    try {
      await worker.ready()
      return worker
    } catch (error) {
      if (this.workers.get(sessionId) === worker) this.workers.delete(sessionId)
      worker.terminate()
      await exited
      const stderr = handle.collected.stderr?.readFrom(0).text.trim()
      throw new Error(
        `session-worker-supervisor: worker failed to start: ${error instanceof Error ? error.message : String(error)}`
        + (stderr === undefined || stderr === '' ? '' : `\n${stderr}`),
        { cause: error },
      )
    }
  }
}

/** One live worker process and its control-channel state. */
class SessionWorkerConnection implements SessionWorkerHandle {
  readonly exited: Promise<void>
  private readonly decoder: SessionWorkerFrameDecoder
  private readonly pending = new Map<string, PromiseWithResolvers<ConnectionRpcResult<unknown>>>()
  private readonly hostCalls = new Set<AbortController>()
  private readonly streams = new Map<string, SessionWorkerStream>()
  private readonly readyDeferred = Promise.withResolvers<void>()
  private readonly idleWaiters = new Set<PromiseWithResolvers<boolean>>()
  private idleTimer: NodeJS.Timeout | undefined
  private idleState = false
  private dead = false
  private finished = false
  private shuttingDown = false
  private pidValue = 0
  private readyTimer: NodeJS.Timeout | undefined

  /**
   * @param sessionId - bound Session identity.
   * @param handle - spawned subprocess handle.
   * @param config - resolved supervisor policy.
   * @param hooks - supervisor removal callback.
   */
  constructor(
    readonly sessionId: SessionId,
    private readonly handle: SubprocessHandle,
    private readonly config: ResolvedConfig,
    private readonly hooks: {
      readonly onClosed: (worker: SessionWorkerConnection) => void
      readonly hostCall: (service: string) => SessionWorkerHostCallHandler | undefined
    },
  ) {
    this.decoder = new SessionWorkerFrameDecoder(config.maxFrameBytes)
    this.exited = handle.done.then(() => undefined, () => undefined).finally(() => {
      this.finish(new Error('session worker exited'))
    })
    this.readyTimer = setTimeout(() => {
      this.failReady(new Error('session worker did not become ready in time'))
    }, config.readyTimeoutMs)
    const control = handle.control
    if (control === undefined) {
      this.failReady(new Error('session worker control channel was not created'))
      return
    }
    control.setEncoding('utf8')
    control.on('data', (chunk: string) => { this.receive(chunk) })
    control.on('error', (error) => { this.receiveFailure(error) })
    control.on('close', () => { this.receiveFailure(new Error('session worker control channel closed')) })
  }

  get pid(): number {
    return this.pidValue
  }

  get idle(): boolean {
    return this.idleState
  }

  get crashed(): boolean {
    return this.finished && !this.shuttingDown
  }

  /** Whether this worker refuses new work because it is draining or gone. */
  get closing(): boolean {
    return this.shuttingDown || this.finished
  }

  /** Resolve once the worker completed ready and initialize. */
  async ready(): Promise<void> {
    return this.readyDeferred.promise
  }

  /** @inheritdoc */
  async call<T = unknown>(
    endpoint: string,
    payload: unknown,
    options: WorkerCallOptions = {},
  ): Promise<ConnectionRpcResult<T>> {
    if (this.dead) return workerFailure('session-worker/unavailable', 'session worker is not running')
    this.touch()
    const requestId = randomUUID()
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: requestId as ClientRequest['rpcId'],
      method: endpoint,
      // Gateway requires the exact `{ args }` envelope on every Remote call.
      payload: { args: payload },
    }
    const deferred = Promise.withResolvers<ConnectionRpcResult<unknown>>()
    this.pending.set(requestId, deferred)
    const onAbort = (): void => {
      if (!this.pending.delete(requestId)) return
      deferred.resolve(workerFailure('gateway/cancelled', 'call was cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    this.write({ channel: 'rpc', type: 'request', requestId, request })
    const result = await deferred.promise
    options.signal?.removeEventListener('abort', onAbort)
    return result as ConnectionRpcResult<T>
  }

  /** @inheritdoc */
  open(endpoint: string, payload: unknown, options: WorkerCallOptions = {}): SessionWorkerStream {
    if (this.dead) throw new Error('session worker is not running')
    if (!isPassiveStreamEndpoint(endpoint)) this.touch()
    const streamId = `stream-${randomUUID()}`
    const stream = new SessionWorkerStream(streamId, this.config.streamBufferItems, {
      send: (frame) => { this.write(frame) },
      cancel: () => { this.streams.delete(streamId) },
    })
    this.streams.set(streamId, stream)
    options.signal?.addEventListener('abort', () => { void stream.cancel('caller cancelled') }, { once: true })
    this.write({ channel: 'mux', type: 'open', streamId, endpoint, payload: { args: payload } })
    return stream
  }

  /** @inheritdoc */
  waitForIdle(timeoutMs: number = this.config.readyTimeoutMs): Promise<boolean> {
    if (this.idleState) return Promise.resolve(true)
    const deferred = Promise.withResolvers<boolean>()
    this.idleWaiters.add(deferred)
    const timer = setTimeout(() => {
      if (!this.idleWaiters.delete(deferred)) return
      deferred.resolve(false)
    }, timeoutMs)
    timer.unref()
    return deferred.promise.finally(() => { clearTimeout(timer) })
  }

  /**
   * Observe every idle transition.
   * @param listener - invoked with the new idle state.
   * @returns disposer removing this exact listener.
   */
  onIdle(listener: (idle: boolean) => void): () => void {
    this.idleListeners.add(listener)
    return () => { this.idleListeners.delete(listener) }
  }

  private readonly idleListeners = new Set<(idle: boolean) => void>()

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    if (this.shuttingDown || this.finished) {
      await this.exited
      return
    }
    this.shuttingDown = true
    this.clearIdleTimer()
    const requestId = randomUUID()
    const acknowledgement = Promise.withResolvers<void>()
    this.shutdownAck = acknowledgement
    this.write({ channel: 'rpc', type: 'shutdown', requestId })
    // A crash or an early exit settles the wait immediately instead of holding
    // the full shutdown budget for an acknowledgement that cannot arrive.
    const settled = Promise.race([
      acknowledgement.promise.catch(() => undefined),
      this.exited,
    ]).then(() => undefined)
    await withTimeout(settled, this.config.shutdownTimeoutMs)
    await this.joinRange()
    this.finish(new Error('session worker was shut down'))
  }

  /** Start the provider's termination ladder and join the managed range. */
  terminate(): void {
    this.handle.terminate()
  }

  private shutdownAck: PromiseWithResolvers<void> | undefined

  private receive(chunk: string): void {
    let frames: ReturnType<SessionWorkerFrameDecoder['push']>
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.receiveFailure(error)
      return
    }
    for (const frame of frames) this.handleFrame(asWorkerToHostFrame(frame))
  }

  private handleFrame(frame: WorkerToHostFrame): void {
    switch (frame.channel) {
      case 'rpc':
        switch (frame.type) {
          case 'ready':
            if (frame.protocolVersion !== SESSION_WORKER_PROTOCOL_VERSION) {
              this.failReady(new Error(
                `session worker protocol ${String(frame.protocolVersion)} does not match ${String(SESSION_WORKER_PROTOCOL_VERSION)}`,
              ))
              return
            }
            this.pidValue = frame.pid
            this.write({
              channel: 'rpc',
              type: 'initialize',
              requestId: randomUUID(),
              payload: { cwd: this.config.cwd, sessionIds: [this.sessionId] },
            })
            return
          case 'initialized':
            if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
            this.readyTimer = undefined
            this.readyDeferred.resolve()
            return
          case 'response':
            this.settleResponse(frame)
            return
          case 'error':
            this.settleError(frame)
            return
          case 'shutdown-result':
            this.shutdownAck?.resolve()
            this.shutdownAck = undefined
            return
          case 'host-call':
            this.handleHostCall(frame)
            return
          /* v8 ignore next 2 -- parser admits only these rpc types. */
          default:
            this.unexpected(frame)
        }
        return
      case 'mux':
        switch (frame.type) {
          case 'item':
            this.streams.get(frame.streamId)?.receive(frame.value)
            return
          case 'end':
            this.streams.get(frame.streamId)?.end()
            return
          case 'error':
            this.streams.get(frame.streamId)?.fail(new SessionWorkerStreamError(frame.error))
            return
          /* v8 ignore next 2 -- parser admits only these mux types. */
          default:
            this.unexpected(frame)
        }
        return
      case 'notify':
        this.observeIdle(frame.idle)
        return
      /* v8 ignore next 2 -- parser admits only these channels. */
      default:
        this.unexpected(frame)
    }
  }

  private handleHostCall(frame: WorkerHostCallFrame): void {
    const handler = this.hooks.hostCall(frame.service)
    if (handler === undefined) {
      this.write({
        channel: 'rpc',
        type: 'host-call-result',
        requestId: frame.requestId,
        result: workerFailure(
          'session-worker/unknown-host-service',
          `worker requested unknown host service ${JSON.stringify(frame.service)}`,
        ),
      })
      return
    }
    const cancellation = new AbortController()
    this.hostCalls.add(cancellation)
    void handler(this.sessionId, frame.method, frame.payload, cancellation.signal)
      .then((result) => {
        this.write({ channel: 'rpc', type: 'host-call-result', requestId: frame.requestId, result })
      })
      .catch((error: unknown) => {
        this.write({
          channel: 'rpc',
          type: 'host-call-result',
          requestId: frame.requestId,
          result: workerFailure(
            'session-worker/host-call-failed',
            error instanceof Error ? error.message : String(error),
          ),
        })
      })
      .finally(() => { this.hostCalls.delete(cancellation) })
  }

  private settleResponse(frame: WorkerUnaryResponseFrame): void {
    const deferred = this.pending.get(frame.requestId)
    if (deferred === undefined) return
    this.pending.delete(frame.requestId)
    const bytes = decodeBody(frame.body)
    const mediaType = frame.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (frame.status < 200 || frame.status >= 300) {
      deferred.resolve(workerFailure('gateway/http-error', httpMessage(frame.status, bytes)))
      return
    }
    if (mediaType !== 'application/json') {
      deferred.resolve(workerFailure('gateway/http-error', httpMessage(frame.status, bytes)))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      deferred.resolve(workerFailure('gateway/internal', 'worker response body is not JSON'))
      return
    }
    if (!isServerResponse(parsed, frame.requestId)) {
      deferred.resolve(workerFailure('gateway/internal', 'worker response envelope is invalid'))
      return
    }
    deferred.resolve(parsed.result)
  }

  private settleError(frame: WorkerRpcErrorFrame): void {
    const deferred = this.pending.get(frame.requestId)
    if (deferred === undefined) return
    this.pending.delete(frame.requestId)
    deferred.resolve({ ok: false, error: frame.error })
  }

  private observeIdle(idle: boolean): void {
    this.idleState = idle
    for (const listener of this.idleListeners) listener(idle)
    if (idle) {
      for (const waiter of this.idleWaiters) waiter.resolve(true)
      this.idleWaiters.clear()
      this.armIdleTimer()
      return
    }
    this.clearIdleTimer()
  }

  private touch(): void {
    if (this.idleState) {
      // Local work already restarts the quiet window in the worker; reflect the
      // same fact here so an armed timer cannot fire during a new call.
      this.idleState = false
      for (const listener of this.idleListeners) listener(false)
    }
    this.clearIdleTimer()
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (this.config.idleTimeoutMs === 0 || this.dead) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.idleState && !this.dead) void this.shutdown()
    }, this.config.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private write(frame: HostToWorkerFrame): void {
    if (this.dead) return
    const control = this.handle.control
    if (control === undefined) return
    try {
      control.write(encodeFrame(frame))
    } catch (error) {
      this.receiveFailure(error)
    }
  }

  private async joinRange(): Promise<void> {
    let exited = false
    try {
      exited = await this.handle.waitForExit(AbortSignal.timeout(this.config.shutdownTimeoutMs))
    } catch {
      exited = false
    }
    if (!exited) {
      this.handle.terminate()
      try {
        await this.handle.waitForExit(AbortSignal.timeout(this.config.shutdownTimeoutMs))
      } catch {
        // The provider owns its final KILL tier; `done` is still awaited below.
      }
    }
    await this.handle.done.catch(() => undefined)
  }

  private receiveFailure(error: unknown): void {
    if (this.dead) return
    this.finish(error instanceof Error ? error : new Error(String(error)))
  }

  private failReady(error: Error): void {
    this.readyDeferred.reject(error)
    this.receiveFailure(error)
  }

  private finish(reason: Error): void {
    if (this.finished) return
    this.finished = true
    this.dead = true
    this.clearIdleTimer()
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    this.readyDeferred.reject(reason)
    for (const deferred of this.pending.values()) {
      deferred.resolve(workerFailure('session-worker/unavailable', reason.message))
    }
    this.pending.clear()
    for (const stream of this.streams.values()) stream.fail(reason)
    this.streams.clear()
    for (const waiter of this.idleWaiters) waiter.resolve(false)
    this.idleWaiters.clear()
    for (const call of this.hostCalls) call.abort(reason)
    this.hostCalls.clear()
    this.shutdownAck?.reject(reason)
    this.shutdownAck = undefined
    this.hooks.onClosed(this)
  }

  private unexpected(frame: never): void {
    this.receiveFailure(new Error(`session worker sent an unexpected frame: ${JSON.stringify(frame)}`))
  }
}

/**
 * One forwarded logical stream over the control channel. Single consumer,
 * cancels on early return, and surfaces worker failures as
 * {@link SessionWorkerStreamError}.
 */
export class SessionWorkerStream implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly queue: AsyncQueue<unknown>
  private terminal = false

  /**
   * @param streamId - correlation id owned by the host.
   * @param bufferItems - maximum buffered downlink items.
   * @param hooks - send and registry callbacks.
   */
  constructor(
    private readonly streamId: string,
    bufferItems: number,
    private readonly hooks: {
      readonly send: (frame: HostToWorkerFrame) => void
      readonly cancel: () => void
    },
  ) {
    this.queue = new AsyncQueue<unknown>(bufferItems)
  }

  /** @returns this stream as its own single-consumer iterator. */
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  /** @returns the next downlink item or terminal result. */
  async next(): Promise<IteratorResult<unknown>> {
    try {
      return await this.queue.next()
    } catch (error) {
      this.terminal = true
      throw error
    }
  }

  /**
   * Cancel the stream; idempotent after a terminal frame.
   * @param reason - diagnostic carried to the worker.
   * @returns a completed iterator result.
   */
  cancel(reason: string = 'stream disposed'): Promise<IteratorResult<unknown>> {
    if (!this.terminal) {
      this.terminal = true
      this.hooks.send({ channel: 'mux', type: 'cancel', streamId: this.streamId, reason })
      this.hooks.cancel()
      this.queue.end()
    }
    return Promise.resolve({ done: true, value: undefined })
  }

  /** @inheritdoc */
  async return(): Promise<IteratorResult<unknown>> {
    return this.cancel()
  }

  /** Accept one downlink item, failing the stream when the buffer overflows. */
  receive(value: unknown): void {
    if (this.terminal) return
    try {
      this.queue.push(value)
    } catch (error) {
      this.fail(error)
    }
  }

  /** Accept normal completion. */
  end(): void {
    if (this.terminal) return
    this.terminal = true
    this.queue.end()
    this.hooks.cancel()
  }

  /** Accept a terminal failure. */
  fail(error: unknown): void {
    if (this.terminal) return
    this.terminal = true
    this.hooks.send({ channel: 'mux', type: 'cancel', streamId: this.streamId, reason: 'stream failed' })
    this.queue.fail(error)
    this.hooks.cancel()
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const command = [...(config.command ?? DEFAULT_WORKER_COMMAND)]
  if (command.length === 0) throw new Error('session-worker-supervisor: command must not be empty')
  return {
    command,
    profile: config.profile ?? DEFAULT_WORKER_PROFILE,
    args: config.args ?? [],
    cwd: config.cwd ?? process.cwd(),
    env: config.env ?? {},
    idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    readyTimeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    maxFrameBytes: config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    streamBufferItems: config.streamBufferItems ?? DEFAULT_STREAM_BUFFER_ITEMS,
    outputBytes: config.outputBytes ?? DEFAULT_CHILD_OUTPUT_BYTES,
  }
}

function workerFailure(code: string, message: string): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

function isServerResponse(value: unknown, rpcId: string): value is ServerResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record['type'] === 'server-response'
    && record['rpcId'] === rpcId
    && typeof record['result'] === 'object'
    && record['result'] !== null
    && typeof (record['result'] as { ok?: unknown }).ok === 'boolean'
}

const MAX_ERROR_BODY_CHARS = 512

function httpMessage(status: number, bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8').trim()
  return text.length === 0
    ? `worker answered HTTP ${String(status)}`
    : `HTTP ${String(status)}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

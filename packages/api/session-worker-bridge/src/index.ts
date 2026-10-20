/**
 * Worker half of the per-session process boundary.
 *
 * The plugin opens the inherited fd 7 control channel, dispatches forwarded
 * unary Remote calls through Connection's shared `/api` Fetch handler, serves
 * forwarded logical streams through the Gateway wire-stream adapter, reports
 * idle transitions, and flushes Sessions before disposing the tree on
 * shutdown. It is mounted only by the `session-worker` profile.
 *
 * @module @deepseek-ai/dsh-session-worker-bridge
 */

import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionFetchHandler, HostConnectionHandle, ClientRequest } from '@deepseek-ai/dsh-client-connection'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'
import {
  AsyncQueue,
  SessionWorkerFrameDecoder,
  SESSION_WORKER_PROTOCOL_VERSION,
  asHostToWorkerFrame,
  encodeBody,
  encodeFrame,
  isPassiveStreamEndpoint,
  type HostToWorkerFrame,
  type WorkerMuxOpenFrame,
  type WorkerToHostFrame,
} from '@deepseek-ai/dsh-session-worker-protocol'
import { WorkerIdleTracker } from './idle.ts'

export { WorkerIdleTracker } from './idle.ts'
export type { WorkerIdleSnapshot } from './idle.ts'

/** Default Session-log quiet window before the worker reports idle. */
export const DEFAULT_IDLE_QUIET_MS = 1_000

/** Default interval between idle observations. */
export const DEFAULT_IDLE_POLL_MS = 250

/** Default bound on buffered uplink items for one forwarded stream. */
export const DEFAULT_MAX_UPLINK_ITEMS = 1_024

/** Bridge deployment configuration. */
export interface Config {
  /** Milliseconds the Session log must stay unchanged. */
  readonly idleQuietMs?: number
  /** Milliseconds between idle observations. */
  readonly idlePollMs?: number
  /** Maximum buffered client uplink items per logical stream. */
  readonly maxUplinkItems?: number
  /** Maximum UTF-8 size of one control frame. */
  readonly maxFrameBytes?: number
}

/** Validated bridge configuration with every default applied. */
interface ResolvedConfig {
  readonly idleQuietMs: number
  readonly idlePollMs: number
  readonly maxUplinkItems: number
  readonly maxFrameBytes: number | undefined
}

/** Cordis plugin configuration schema. */
export const Config: z<Config> = z.object({
  idleQuietMs: z.natural().min(0).default(DEFAULT_IDLE_QUIET_MS),
  idlePollMs: z.natural().min(1).default(DEFAULT_IDLE_POLL_MS),
  maxUplinkItems: z.natural().min(1).default(DEFAULT_MAX_UPLINK_ITEMS),
  maxFrameBytes: z.natural().min(1),
})

/** Stable Cordis plugin name. */
export const name = 'session-worker-bridge'

/** Services that must exist before the bridge can dispatch forwarded calls. */
export const inject = ['agents', 'connection', 'sessionController', 'sessions', 'typertGateway']

interface ActiveMuxStream {
  readonly abort: AbortController
  readonly uplink: AsyncQueue<unknown>
}

/**
 * Mount the worker control-channel bridge.
 * @param ctx - worker tree context.
 * @param config - idle and uplink limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const bridge = new SessionWorkerBridge(ctx, resolveConfig(config))
  ctx.effect(() => () => { bridge.dispose() }, 'session-worker-bridge: control channel')
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    idleQuietMs: config.idleQuietMs ?? DEFAULT_IDLE_QUIET_MS,
    idlePollMs: config.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
    maxUplinkItems: config.maxUplinkItems ?? DEFAULT_MAX_UPLINK_ITEMS,
    maxFrameBytes: config.maxFrameBytes,
  }
}

/** Owns one worker's inherited control channel and all forwarded work. */
class SessionWorkerBridge {
  private readonly channel: Duplex
  private readonly decoder: SessionWorkerFrameDecoder
  private readonly connection: HostConnectionHandle
  private readonly gateway: TypertGateway
  private readonly handler: ConnectionFetchHandler
  private readonly idle: WorkerIdleTracker
  private readonly muxStreams = new Map<string, ActiveMuxStream>()
  private readonly disposers: (() => void)[] = []
  private idleTimer: NodeJS.Timeout | undefined
  private lastIdle: boolean | undefined
  private tickRunning = false
  private draining = false
  private shutdownPromise: Promise<void> | undefined
  private disposed = false

  /**
   * @param ctx - worker tree context.
   * @param config - resolved bridge limits.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.channel = openInheritedControlChannel()
    this.decoder = new SessionWorkerFrameDecoder(config.maxFrameBytes)
    this.connection = ctx.connection
    this.gateway = ctx.typertGateway
    this.handler = this.connection.createSharedFetchHandler('/api')
    this.idle = new WorkerIdleTracker(ctx, config.idleQuietMs)

    this.channel.setEncoding('utf8')
    this.channel.on('data', (chunk: string) => { this.receive(chunk) })
    this.channel.on('error', (error) => { this.ctx.logger.error('session-worker: control channel failed', error) })
    this.channel.on('end', () => { this.handleEof() })

    this.disposers.push(
      ctx.on('session/event', () => { this.idle.noteSessionEvent() }),
      ctx.on('agent/status', ({ status }) => { if (status === 'running') this.idle.noteActivity() }),
      ctx.on('agent/assistant-stream', ({ agent, frame }) => { this.idle.noteAssistantFrame(agent, frame) }),
    )

    this.idleTimer = setInterval(() => { void this.tickIdle() }, config.idlePollMs)
    this.idleTimer.unref()
    this.send({ channel: 'rpc', type: 'ready', protocolVersion: SESSION_WORKER_PROTOCOL_VERSION, pid: process.pid })
  }

  /** Release the channel, timer, and subscriptions exactly once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.idleTimer = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const stream of this.muxStreams.values()) {
      stream.abort.abort(new Error('session-worker: bridge disposed'))
      stream.uplink.fail(new Error('session-worker: bridge disposed'))
    }
    this.muxStreams.clear()
    this.channel.removeAllListeners()
    this.channel.destroy()
  }

  private receive(chunk: string): void {
    let frames: ReturnType<SessionWorkerFrameDecoder['push']>
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.failControl(error)
      return
    }
    for (const frame of frames) {
      try {
        this.handleFrame(asHostToWorkerFrame(frame))
      } catch (error) {
        this.failControl(error)
        return
      }
    }
  }

  private handleFrame(frame: HostToWorkerFrame): void {
    switch (frame.channel) {
      case 'rpc':
        switch (frame.type) {
          case 'initialize':
            this.idle.noteActivity()
            this.send({
              channel: 'rpc',
              type: 'initialized',
              requestId: frame.requestId,
              pid: process.pid,
            })
            return
          case 'request':
            this.idle.noteActivity()
            void this.dispatchUnary(frame.requestId, frame.request)
            return
          case 'shutdown':
            this.beginShutdown(frame.requestId)
            return
          /* v8 ignore next 2 -- the protocol parser admits only these rpc types. */
          default:
            this.unexpected(frame)
        }
        return
      case 'mux':
        this.handleMux(frame)
        return
      /* v8 ignore next 2 -- asHostToWorkerFrame admits only rpc and mux. */
      default:
        this.unexpected(frame)
    }
  }

  private handleMux(frame: Extract<HostToWorkerFrame, { readonly channel: 'mux' }>): void {
    switch (frame.type) {
      case 'open':
        this.openMux(frame)
        return
      case 'item': {
        const stream = this.muxStreams.get(frame.streamId)
        if (stream === undefined) return
        try {
          stream.uplink.push(frame.value)
        } catch (error) {
          stream.uplink.fail(error)
          stream.abort.abort(error)
        }
        return
      }
      case 'end':
        this.muxStreams.get(frame.streamId)?.uplink.end()
        return
      case 'cancel': {
        const stream = this.muxStreams.get(frame.streamId)
        if (stream === undefined) return
        const reason = new Error(frame.reason ?? 'Remote stream cancelled')
        stream.abort.abort(reason)
        stream.uplink.fail(reason)
        return
      }
      /* v8 ignore next 2 -- the protocol parser admits only these mux types. */
      default:
        this.unexpected(frame)
    }
  }

  private openMux(frame: WorkerMuxOpenFrame): void {
    if (this.muxStreams.has(frame.streamId)) {
      this.send({
        channel: 'mux',
        type: 'error',
        streamId: frame.streamId,
        error: { code: 'session-worker/protocol', message: 'duplicate stream id', details: {} },
      })
      return
    }
    if (!isPassiveStreamEndpoint(frame.endpoint)) this.idle.noteActivity()
    const abort = new AbortController()
    const uplink = new AsyncQueue<unknown>(this.config.maxUplinkItems)
    this.muxStreams.set(frame.streamId, { abort, uplink })
    void this.pumpMux(frame, abort, uplink)
  }

  private async pumpMux(
    frame: WorkerMuxOpenFrame,
    abort: AbortController,
    uplink: AsyncQueue<unknown>,
  ): Promise<void> {
    try {
      const source = await this.gateway.wireStream.open(
        frame.endpoint,
        frame.payload,
        uplink,
        this.connection.browserPeer,
        abort.signal,
      )
      for await (const value of source) {
        this.send({ channel: 'mux', type: 'item', streamId: frame.streamId, value })
      }
      this.send({ channel: 'mux', type: 'end', streamId: frame.streamId })
    } catch (error) {
      if (abort.signal.aborted) {
        this.send({ channel: 'mux', type: 'end', streamId: frame.streamId })
      } else {
        this.send({
          channel: 'mux',
          type: 'error',
          streamId: frame.streamId,
          error: this.gateway.wireStream.failure(error),
        })
      }
    } finally {
      this.muxStreams.delete(frame.streamId)
      uplink.end()
    }
  }

  private async dispatchUnary(requestId: string, request: ClientRequest): Promise<void> {
    if (this.draining) {
      this.send({
        channel: 'rpc',
        type: 'error',
        requestId,
        error: { code: 'session-worker/shutting-down', message: 'worker is shutting down', details: {} },
      })
      return
    }
    try {
      const response = await this.handler.fetch(
        new Request(new URL(`/api/${request.method}`, 'http://session-worker.invalid'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        }),
        this.connection.browserPeer,
      )
      const body = new Uint8Array(await response.arrayBuffer())
      this.send({
        channel: 'rpc',
        type: 'response',
        requestId,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: encodeBody(body),
      })
    } catch (error) {
      this.send({
        channel: 'rpc',
        type: 'error',
        requestId,
        error: {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      })
    }
  }

  private beginShutdown(requestId: string): void {
    if (this.shutdownPromise !== undefined) return
    this.draining = true
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.idleTimer = undefined
    this.shutdownPromise = this.performShutdown(requestId)
  }

  private async performShutdown(requestId: string): Promise<void> {
    for (const stream of this.muxStreams.values()) {
      stream.abort.abort(new Error('session-worker: shutting down'))
      stream.uplink.fail(new Error('session-worker: shutting down'))
    }
    let flushedSessions = 0
    try {
      for (const agent of this.ctx.agents.list()) {
        await this.ctx.sessions.flush(agent.session)
        flushedSessions += 1
      }
      const persistence = this.ctx.get('sessionPersistence')
      await persistence?.flush()
      await this.write({ channel: 'rpc', type: 'shutdown-result', requestId, flushedSessions })
    } catch (error) {
      this.send({
        channel: 'rpc',
        type: 'error',
        requestId,
        error: {
          code: 'session-worker/shutdown-failed',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      })
    }
    setImmediate(() => {
      void this.ctx.root.fiber.dispose()
        .catch((error: unknown) => { console.error('session-worker: tree disposal failed:', error) })
        .finally(() => { process.exit(0) })
    })
  }

  private async tickIdle(): Promise<void> {
    if (this.tickRunning || this.draining || this.disposed) return
    this.tickRunning = true
    try {
      const snapshot = await this.idle.inspect()
      if (snapshot.idle === this.lastIdle) return
      this.lastIdle = snapshot.idle
      this.send({
        channel: 'notify',
        type: 'idle',
        idle: snapshot.idle,
        reason: snapshot.reason,
        sessions: this.idle.sessions,
      })
    } catch (error) {
      this.ctx.logger.warn('session-worker: idle observation failed', error)
    } finally {
      this.tickRunning = false
    }
  }

  private send(frame: WorkerToHostFrame): void {
    if (this.disposed) return
    try {
      this.channel.write(encodeFrame(frame))
    } catch (error) {
      this.ctx.logger.error('session-worker: failed to send control frame', error)
    }
  }

  private write(frame: WorkerToHostFrame): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return new Promise((resolve) => {
      this.channel.write(encodeFrame(frame), () => { resolve() })
    })
  }

  private handleEof(): void {
    // A vanished host must not leave the worker running with no control path.
    if (this.shutdownPromise !== undefined) return
    this.draining = true
    setImmediate(() => {
      void this.ctx.root.fiber.dispose().finally(() => { process.exit(0) })
    })
  }

  private failControl(error: unknown): void {
    this.ctx.logger.error('session-worker: invalid control frame', error)
    this.dispose()
    void this.ctx.root.fiber.dispose().finally(() => { process.exit(1) })
  }

  private unexpected(frame: never): void {
    throw new Error(`session-worker: unexpected frame ${JSON.stringify(frame)}`)
  }
}

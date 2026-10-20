/**
 * Relay Session-worker Remote events into the Host's browser event stream.
 *
 * A worker mounts the same Remote event assembly as the Host, but no browser
 * connects to it. The relay keeps one `$events` logical stream per worker and
 * fans its notifications and scoped waterfalls out to every Host event source.
 * A browser answer travels back as `$events/result` addressed to the worker's
 * own client and event ids, so approval and user-question waterfalls work
 * exactly once across the process boundary.
 *
 * Pumps run only while a browser event source is subscribed: with no browser,
 * the worker's own event listeners stay unattached and its waterfalls settle
 * locally, matching the single-process behavior.
 *
 * @module @deepseek-ai/dsh-session-worker-host/events
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  TypertRemoteEventDispatch,
  TypertRemoteEventInvocation,
  TypertRemoteEventRelay,
} from '@deepseek-ai/dsh-api-gateway'
import {
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  projectRemoteEventRejection,
  type RemoteEventClientId,
  type RemoteEventDownlinkFrame,
  type RemoteEventId,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TypertResourceReader } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionWorkerHandle } from '@deepseek-ai/dsh-session-worker-supervisor'

/** Resource readers declared once by the Host event allowlist. */
const EVENT_RESOURCES: ReadonlyMap<string, Readonly<Record<string, TypertResourceReader>>> = new Map(
  API_REMOTE_FORWARDED_EVENTS.flatMap(entry =>
    'resources' in entry
      ? [[entry.event, entry.resources as Readonly<Record<string, TypertResourceReader>>] as const]
      : []),
)

/** Forwarded worker stream: single-consumer iterable that can be cancelled. */
type WorkerEventStream = AsyncIterable<unknown> & { cancel(reason?: string): Promise<unknown> }

/** One worker whose event stream the Host may be observing. */
interface WorkerEvents {
  readonly sessionId: SessionId
  readonly worker: SessionWorkerHandle
  /** Rejects every pending Host waterfall when the worker is replaced or dies. */
  readonly lifetime: AbortController
  /** Per-worker-event cancellation signalled by a worker `cancel` frame. */
  readonly pending: Map<RemoteEventId, AbortController>
  stream: WorkerEventStream | undefined
  clientId: RemoteEventClientId | undefined
  stopped: boolean
}

/**
 * Host relay service (`ctx.sessionWorkerEventRelay`).
 */
export class SessionWorkerEvents implements TypertRemoteEventRelay {
  private readonly workers = new Map<SessionId, WorkerEvents>()
  private readonly listeners = new Set<(dispatch: TypertRemoteEventDispatch) => void>()

  /** @param ctx - Host context used for diagnostics and waterfall ownership. */
  constructor(private readonly ctx: Context) {}

  /**
   * Bind the event stream to a worker generation. Re-attaching the same worker
   * is a no-op; a replacement cancels the old generation's stream and every
   * waterfall still waiting on it.
   * @param sessionId - ordinary Session identity.
   * @param worker - ready worker handle.
   */
  attach(sessionId: SessionId, worker: SessionWorkerHandle): void {
    const existing = this.workers.get(sessionId)
    if (existing?.worker === worker) return
    if (existing !== undefined) this.stop(existing)
    const events: WorkerEvents = {
      sessionId,
      worker,
      lifetime: new AbortController(),
      pending: new Map(),
      stream: undefined,
      clientId: undefined,
      stopped: false,
    }
    this.workers.set(sessionId, events)
    void worker.exited.then(() => {
      if (this.workers.get(sessionId) !== events) return
      this.stop(events)
      this.workers.delete(sessionId)
    })
    if (this.listeners.size > 0) this.start(events)
  }

  /** @inheritdoc */
  onEvent(listener: (dispatch: TypertRemoteEventDispatch) => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      for (const events of this.workers.values()) this.start(events)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        for (const events of this.workers.values()) this.stop(events)
      }
    }
  }

  private start(events: WorkerEvents): void {
    if (events.stream !== undefined || events.stopped) return
    try {
      events.stream = events.worker.open(REMOTE_EVENT_STREAM_ENDPOINT, {})
    } catch (error) {
      this.ctx.logger.warn(`session-worker: event stream for "${events.sessionId}" failed to open`, error)
      return
    }
    void this.pump(events, events.stream)
  }

  private stop(events: WorkerEvents): void {
    if (events.stopped) return
    events.stopped = true
    const stream = events.stream
    events.stream = undefined
    void stream?.cancel('host stopped observing worker events')
    // A vanished worker must reject every waterfall its browser is still
    // showing; the Gateway owns the browser-facing cancellation frame.
    events.lifetime.abort(new Error('session-worker: event source stopped'))
    for (const controller of events.pending.values()) {
      controller.abort(new Error('session-worker: waterfall was cancelled by the worker'))
    }
    events.pending.clear()
  }

  private async pump(events: WorkerEvents, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const item of stream) {
        if (events.stopped) return
        if (!isRecord(item)) continue
        const frame = item as unknown as RemoteEventDownlinkFrame
        switch (frame.type) {
          case 'ready':
            events.clientId = frame.clientId
            break
          case 'emit':
            this.emit(frame)
            break
          case 'waterfall':
            this.waterfall(events, frame)
            break
          case 'cancel':
            events.pending.get(frame.eventId)?.abort(
              new Error('session-worker: waterfall was cancelled by the worker'),
            )
            break
        }
      }
    } catch (error) {
      if (!events.stopped) {
        this.ctx.logger.warn(`session-worker: event stream for "${events.sessionId}" ended`, error)
      }
    } finally {
      // A stream that ends without an explicit stop means the worker is gone;
      // the exit hook owns removal, but pending answers must not hang here.
      if (!events.stopped) {
        events.stream = undefined
        events.lifetime.abort(new Error('session-worker: event stream ended'))
      }
    }
  }

  private emit(frame: { readonly event: string; readonly args: readonly unknown[] }): void {
    const resources = EVENT_RESOURCES.get(frame.event)
    const dispatch: TypertRemoteEventDispatch = {
      event: frame.event,
      args: frame.args,
      ...resources === undefined ? {} : { resources },
    }
    for (const listener of this.listeners) listener(dispatch)
  }

  private waterfall(
    events: WorkerEvents,
    frame: Extract<RemoteEventDownlinkFrame, { readonly type: 'waterfall' }>,
  ): void {
    // The wire request already dropped its Agent object. Re-attach one so the
    // Host Gateway's scoped projection accepts it; the object is local to this
    // invocation and never crosses a boundary.
    const subject = {}
    const request: Record<string, unknown> = { ...frame.request, agent: subject }
    const cancellation = new AbortController()
    events.pending.set(frame.eventId, cancellation)
    const close = (): void => { events.pending.delete(frame.eventId) }
    const invocation: TypertRemoteEventInvocation = {
      event: frame.event,
      request,
      context: {
        value: this.ctx,
        subject,
        agentId: frame.agentId,
        lifetime: AbortSignal.any([events.lifetime.signal, cancellation.signal]),
      },
      resolve: (outcome) => {
        close()
        this.answer(events, frame.eventId, outcome.kind === 'result'
          ? { kind: 'result', ...outcome.value === undefined ? {} : { value: outcome.value } }
          : { kind: 'next' })
      },
      reject: (reason) => {
        close()
        this.answer(events, frame.eventId, {
          kind: 'rejected',
          error: projectRemoteEventRejection(reason),
        })
      },
    }
    for (const listener of this.listeners) listener(invocation)
  }

  private answer(
    events: WorkerEvents,
    eventId: RemoteEventId,
    outcome:
      | { readonly kind: 'next' }
      | { readonly kind: 'result'; readonly value?: unknown }
      | { readonly kind: 'rejected'; readonly error: ReturnType<typeof projectRemoteEventRejection> },
  ): void {
    const clientId = events.clientId
    if (clientId === undefined) {
      this.ctx.logger.warn(
        `session-worker: waterfall "${String(eventId)}" arrived before the worker event stream was ready`,
      )
      return
    }
    void events.worker.call(REMOTE_EVENT_RESULT_ENDPOINT, { clientId, eventId, outcome })
      .then((result) => {
        if (!result.ok) {
          this.ctx.logger.warn(
            `session-worker: waterfall "${String(eventId)}" answer was refused: ${result.error.message}`,
          )
        }
      })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

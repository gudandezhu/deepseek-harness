/**
 * Host-owned live state for Sessions whose Agent runs in a session worker.
 *
 * The Host keeps the browser-facing `session.follow` and `session.control`
 * streams alive across worker generations. One worker `session/follow`
 * supplies the opening window, durable events, and Assistant frames; one
 * worker `session/control` supplies projection baselines and updates. Both are
 * passive in the worker, so an open browser never postpones idle reclaim.
 *
 * @module @deepseek-ai/dsh-api-session-controller/session-worker/live-state
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { SessionAssistantStreamAccumulator } from '../assistant-stream.ts'
import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionHistoryRecord,
  SessionProjectionBaseline,
  SessionProjectionHints,
  SessionSummary,
} from '../types.ts'

/** Default number of retained live events per Session. */
export const DEFAULT_LIVE_EVENT_LIMIT = 4_096

/** Default message window the Host asks a worker for when it attaches. */
export const DEFAULT_LIVE_WINDOW_MESSAGES = 50

/** Compaction threshold for the retained event array. */
const EVENT_COMPACT_THRESHOLD = 1_024

/** Live worker call surface; structurally satisfied by `SessionWorkerHandle`. */
export interface SessionWorkerTransport {
  /** Worker process id, used only for diagnostics. */
  readonly pid: number
  /** Resolves after the worker process range is empty. */
  readonly exited: Promise<void>
  /** Open one forwarded logical stream. */
  open(endpoint: string, payload: unknown, options?: { readonly signal?: AbortSignal }): SessionWorkerStreamTransport
}

/** One forwarded worker stream; structurally satisfied by `SessionWorkerStream`. */
export interface SessionWorkerStreamTransport extends AsyncIterable<unknown> {
  /** Cancel the logical stream; idempotent. */
  cancel(reason?: string): Promise<unknown>
}

/** One contiguous Session window the Host can serve without a worker call. */
export interface SessionLiveView {
  readonly sessionId: SessionId
  readonly header: SessionHeader
  /** Last sequence represented by {@link events}. */
  readonly cursor: SessionSeqCursor
  /** Contiguous events starting at {@link baseSeq}. */
  readonly events: readonly SessionEvent[]
  readonly baseSeq: number
  /** Whether events older than {@link baseSeq} exist. */
  readonly hasMore: boolean
  readonly projections: SessionProjectionBaseline
  readonly assistantStream: SessionAssistantStreamBaseline
  /** Worker attachment generation; changes force followers to reset. */
  readonly generation: number
  readonly running: boolean
  readonly agentAvailable: boolean
}

/** One projection update from a worker control stream. */
export interface SessionLiveProjection {
  readonly sessionId: SessionId
  readonly key: string
  readonly value: JsonValue
  readonly seq: number
}

/** Callbacks the Host Session Controller registers against live state. */
export interface SessionLiveListeners {
  readonly event: (sessionId: SessionId, event: SessionEvent) => void
  readonly assistant: (sessionId: SessionId, frame: SessionAssistantStreamFrame) => void
  readonly projection: (update: SessionLiveProjection) => void
  /** A worker attachment published a fresh opening window. */
  readonly generation: (sessionId: SessionId) => void
}

/** One Session's retained live state. */
interface LiveSession {
  readonly sessionId: SessionId
  generation: number
  worker: SessionWorkerTransport | undefined
  header: SessionHeader | undefined
  events: SessionEvent[]
  head: number
  baseSeq: number
  lastSeq: number
  windowHasMore: boolean
  dropped: boolean
  projections: SessionProjectionBaseline
  assistant: SessionAssistantStreamAccumulator
  running: boolean
  hasTurn: boolean
  follow: SessionWorkerStreamTransport | undefined
  control: SessionWorkerStreamTransport | undefined
}

/**
 * Per-Session live cache fed by worker control channels.
 *
 * The service is inert until a host router attaches a worker, so the same
 * Session Controller package also composes inside a worker process.
 */
export class SessionWorkerLives {
  private readonly sessions = new Map<SessionId, LiveSession>()
  private readonly listeners = new Set<SessionLiveListeners>()

  /**
   * @param ctx - host context; used for status publication and diagnostics.
   * @param eventLimit - retained events per Session.
   */
  constructor(
    private readonly ctx: Context,
    private readonly eventLimit: number = DEFAULT_LIVE_EVENT_LIMIT,
  ) {}

  /**
   * Observe live state updates.
   * @param listeners - callbacks receiving events, Assistant frames, projections, and generations.
   * @returns disposer removing this exact listener set.
   */
  observe(listeners: SessionLiveListeners): () => void {
    this.listeners.add(listeners)
    return () => { this.listeners.delete(listeners) }
  }

  /**
   * Bind a worker generation to a Session and start consuming its passive
   * streams. Re-attaching the same worker is a no-op.
   * @param sessionId - ordinary Session identity.
   * @param worker - ready worker handle.
   * @param windowMessages - message window requested in the opening snapshot.
   */
  attach(sessionId: SessionId, worker: SessionWorkerTransport, windowMessages: number = DEFAULT_LIVE_WINDOW_MESSAGES): void {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        generation: 0,
        worker: undefined,
        header: undefined,
        events: [],
        head: 0,
        baseSeq: 0,
        lastSeq: -1,
        windowHasMore: false,
        dropped: false,
        projections: { asOfSeq: -1, values: {} },
        assistant: new SessionAssistantStreamAccumulator(),
        running: false,
        hasTurn: false,
        follow: undefined,
        control: undefined,
      }
      this.sessions.set(sessionId, state)
    } else if (state.worker === worker) {
      return
    }
    state.generation += 1
    const generation = state.generation
    // A previous generation's streams belong to a dead or retiring process.
    void state.follow?.cancel('worker generation replaced')
    void state.control?.cancel('worker generation replaced')
    state.follow = undefined
    state.control = undefined
    state.worker = worker
    state.header = undefined
    state.events = []
    state.head = 0
    state.baseSeq = 0
    state.lastSeq = -1
    state.windowHasMore = false
    state.dropped = false
    state.running = false
    state.hasTurn = false
    this.followWorker(state, worker, generation, windowMessages)
    this.followControl(state, worker, generation)
    void worker.exited.then(() => {
      if (state.generation !== generation) return
      state.worker = undefined
      state.running = false
      this.ctx.emit('api-session/status', sessionId, false)
    })
  }

  /**
   * Report whether a worker owned this Session at least once, even before its
   * first opening snapshot arrives.
   * @param sessionId - ordinary Session identity.
   * @returns true when live state exists for the Session.
   */
  has(sessionId: SessionId): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Report whether a worker process currently owns the Session.
   * @param sessionId - ordinary Session identity.
   * @returns true while the attached worker has not exited.
   */
  workerAvailable(sessionId: SessionId): boolean {
    return this.sessions.get(sessionId)?.worker !== undefined
  }

  /**
   * Look up the retained opening window for one Session.
   * @param sessionId - ordinary Session identity.
   * @returns the live view, or undefined before the first worker snapshot.
   */
  view(sessionId: SessionId): SessionLiveView | undefined {
    const state = this.sessions.get(sessionId)
    if (state?.header === undefined) return undefined
    return {
      sessionId,
      header: state.header,
      cursor: state.lastSeq as SessionSeqCursor,
      events: state.events.slice(state.head),
      baseSeq: state.baseSeq,
      hasMore: state.windowHasMore || state.dropped,
      projections: state.projections,
      assistantStream: state.assistant.snapshot(),
      generation: state.generation,
      running: state.running,
      agentAvailable: state.worker !== undefined,
    }
  }

  /**
   * Read every live Session's projection baseline for one control generation.
   * @returns retained projection blocks keyed by Session.
   */
  projectionBaselines(): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const [sessionId, state] of this.sessions) {
      if (state.header === undefined) continue
      blocks[sessionId] = state.projections
    }
    return blocks
  }

  /**
   * Overlay live availability, running state, and projections on a cold list.
   * @param items - Host-read Session summaries.
   * @returns summaries including Sessions that exist only in a worker.
   */
  overlay(items: readonly SessionSummary[]): SessionSummary[] {
    const rows = new Map(items.map(item => [item.sessionId, item]))
    for (const [sessionId, state] of this.sessions) {
      if (state.header === undefined) continue
      const projections = this.hints(state)
      const row = rows.get(sessionId)
      rows.set(sessionId, row === undefined
        ? {
          sessionId,
          updatedAt: state.header.createdAt,
          agentAvailable: state.worker !== undefined,
          running: state.running,
          blank: !state.hasTurn,
          formatStatus: 'current',
          ...(state.header.cwd === undefined ? {} : { cwd: state.header.cwd }),
          ...(projections === undefined ? {} : { projections }),
        }
        : {
          ...row,
          agentAvailable: row.agentAvailable || state.worker !== undefined,
          running: state.running,
          ...(projections === undefined ? {} : { projections }),
        })
    }
    return [...rows.values()]
  }

  private hints(state: LiveSession): SessionProjectionHints | undefined {
    const values = state.projections.values
    return Object.keys(values).length === 0
      ? undefined
      : { kind: 'sequenced', asOfSeq: state.projections.asOfSeq, values }
  }

  private followWorker(
    state: LiveSession,
    worker: SessionWorkerTransport,
    generation: number,
    windowMessages: number,
  ): void {
    let stream: SessionWorkerStreamTransport
    try {
      stream = worker.open('session/follow', {
        request: {
          address: { kind: 'session', sessionId: state.sessionId },
          assistantStream: true,
          maxMessages: windowMessages,
        },
      })
    } catch (error) {
      this.ctx.logger.warn(`session-worker: follow for "${state.sessionId}" failed to open`, error)
      return
    }
    state.follow = stream
    void this.consumeFollow(state, stream, generation)
  }

  private async consumeFollow(
    state: LiveSession,
    stream: SessionWorkerStreamTransport,
    generation: number,
  ): Promise<void> {
    try {
      for await (const item of stream) {
        if (!this.current(state, generation)) return
        if (!isRecord(item)) continue
        switch (item['type']) {
          case 'snapshot':
            this.applySnapshot(state, item)
            break
          case 'event':
            if (isRecord(item['event'])) this.appendEvent(state, item['event'] as unknown as SessionEvent)
            break
          case 'assistant-stream':
            if (isRecord(item['frame'])) this.appendAssistant(state, item['frame'] as unknown as SessionAssistantStreamFrame)
            break
          default:
            break
        }
      }
    } catch (error) {
      if (this.current(state, generation)) {
        this.ctx.logger.warn(`session-worker: follow for "${state.sessionId}" ended`, error)
      }
    }
  }

  private applySnapshot(state: LiveSession, frame: Record<string, unknown>): void {
    const records = Array.isArray(frame['records']) ? frame['records'] as SessionHistoryRecord[] : []
    const events = records.map(record => record.event as unknown as SessionEvent)
    state.header = frame['header'] as unknown as SessionHeader
    state.events = events
    state.head = 0
    state.baseSeq = events[0]?.seq ?? 0
    state.lastSeq = typeof frame['cursor'] === 'number' ? frame['cursor'] : state.baseSeq - 1
    state.hasTurn = events.some(entry => entry.type === 'turn/start')
    state.windowHasMore = frame['hasMore'] === true
    state.dropped = false
    const projections = frame['projections']
    if (isRecord(projections) && typeof projections['asOfSeq'] === 'number' && isRecord(projections['values'])) {
      state.projections = {
        asOfSeq: projections['asOfSeq'],
        values: projections['values'] as Record<string, JsonValue>,
      }
    }
    const assistant = frame['assistantStream']
    if (isRecord(assistant) && typeof assistant['revision'] === 'number') {
      state.assistant.seed(assistant as unknown as SessionAssistantStreamBaseline)
    }
    for (const listener of this.listeners) listener.generation(state.sessionId)
  }

  private appendEvent(state: LiveSession, event: SessionEvent): void {
    if (event.seq <= state.lastSeq) return
    if (event.seq !== state.lastSeq + 1) {
      this.ctx.logger.warn(
        `session-worker: live event gap for "${state.sessionId}": expected ${String(state.lastSeq + 1)}, got ${String(event.seq)}`,
      )
      return
    }
    state.events.push(event)
    state.lastSeq = event.seq
    if (state.events.length - state.head > this.eventLimit) {
      state.head += 1
      state.baseSeq = state.events[state.head]?.seq ?? event.seq
      state.dropped = true
      if (state.head >= EVENT_COMPACT_THRESHOLD) {
        state.events = state.events.slice(state.head)
        state.head = 0
      }
    }
    if (event.type === 'turn/start') {
      state.hasTurn = true
      if (!state.running) {
        state.running = true
        this.ctx.emit('api-session/status', state.sessionId, true)
      }
    } else if (event.type === 'turn/end' && state.running) {
      state.running = false
      this.ctx.emit('api-session/status', state.sessionId, false)
    }
    for (const listener of this.listeners) listener.event(state.sessionId, event)
  }

  private appendAssistant(state: LiveSession, frame: SessionAssistantStreamFrame): void {
    if (frame.type === 'start') {
      state.assistant.accept({
        type: 'start',
        attemptId: frame.attemptId,
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
      }, frame.startedAfterSeq)
    } else {
      // Chunk and end frames do not read the durable cursor.
      state.assistant.accept(frame as unknown as AssistantStreamFrame, state.lastSeq as SessionSeqCursor)
    }
    for (const listener of this.listeners) listener.assistant(state.sessionId, frame)
  }

  private followControl(state: LiveSession, worker: SessionWorkerTransport, generation: number): void {
    let stream: SessionWorkerStreamTransport
    try {
      stream = worker.open('session/control', {})
    } catch (error) {
      this.ctx.logger.warn(`session-worker: control for "${state.sessionId}" failed to open`, error)
      return
    }
    state.control = stream
    void this.consumeControl(state, stream, generation)
  }

  private async consumeControl(
    state: LiveSession,
    stream: SessionWorkerStreamTransport,
    generation: number,
  ): Promise<void> {
    try {
      for await (const item of stream) {
        if (!this.current(state, generation)) return
        if (!isRecord(item)) continue
        if (item['type'] === 'baseline') {
          const value = item['value']
          if (!isRecord(value) || !isRecord(value['projections'])) continue
          const block = value['projections'][state.sessionId]
          if (!isRecord(block) || typeof block['asOfSeq'] !== 'number' || !isRecord(block['values'])) continue
          state.projections = {
            asOfSeq: block['asOfSeq'],
            values: block['values'] as Record<string, JsonValue>,
          }
          for (const [key, entry] of Object.entries(state.projections.values)) {
            this.publishProjection(state.sessionId, key, entry as JsonValue, state.projections.asOfSeq)
          }
          continue
        }
        if (item['type'] !== 'projection' || item['sessionId'] !== state.sessionId) continue
        const seq = item['seq']
        if (typeof seq !== 'number' || typeof item['key'] !== 'string') continue
        state.projections = {
          asOfSeq: seq,
          values: { ...state.projections.values, [item['key']]: item['value'] as JsonValue },
        }
        this.publishProjection(state.sessionId, item['key'], item['value'] as JsonValue, seq)
      }
    } catch (error) {
      if (this.current(state, generation)) {
        this.ctx.logger.warn(`session-worker: control for "${state.sessionId}" ended`, error)
      }
    }
  }

  private publishProjection(sessionId: SessionId, key: string, value: JsonValue, seq: number): void {
    for (const listener of this.listeners) listener.projection({ sessionId, key, value, seq })
  }

  private current(state: LiveSession, generation: number): boolean {
    return state.generation === generation
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned live state for Sessions whose Agent runs in a worker. */
    sessionWorkerLives?: SessionWorkerLives
  }
}

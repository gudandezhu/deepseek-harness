/**
 * Line-delimited JSON frames carried by the session-worker control channel.
 *
 * The channel is the inherited fd 7 byte pipe from
 * `@deepseek-ai/dsh-subprocess/control`. Three logical channels share it:
 * `rpc` (initialize, unary Connection envelopes, shutdown), `mux` (logical
 * Remote streams), and `notify` (worker lifecycle facts such as idle).
 * Reusing Connection's `ClientRequest` envelope and Gateway's stream endpoint
 * vocabulary keeps the worker a normal in-process API consumer.
 *
 * @module @deepseek-ai/dsh-session-worker-protocol
 */

import type { ClientRequest, ConnectionRpcFailure } from '@deepseek-ai/dsh-client-connection'

export { AsyncQueue, AsyncQueueOverflowError } from './async-queue.ts'

/** Protocol revision exchanged by initialize and ready. */
export const SESSION_WORKER_PROTOCOL_VERSION = 1

/** Default maximum size of one complete JSON line, in UTF-8 bytes. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Logical channels multiplexed by the byte pipe. */
export type SessionWorkerChannel = 'rpc' | 'mux' | 'notify'

/** Stable protocol failure raised while framing or validating a frame. */
export class SessionWorkerProtocolError extends Error {
  /** Stable diagnostic code. */
  readonly code = 'session-worker/protocol'

  /**
   * @param message - correction-oriented diagnostic.
   * @param options - optional contained failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(`session-worker: ${message}`, options)
    this.name = 'SessionWorkerProtocolError'
  }
}

/** Host-to-worker initialization payload. */
export interface WorkerInitializeRequest {
  /** Working directory the worker reports for diagnostics. */
  readonly cwd: string
  /** Sessions the host currently maps to this worker. */
  readonly sessionIds: readonly string[]
}

/** Host asks the worker to adopt the connection generation. */
export interface WorkerInitializeFrame {
  readonly channel: 'rpc'
  readonly type: 'initialize'
  readonly requestId: string
  readonly payload: WorkerInitializeRequest
}

/** Worker proves its protocol revision and process identity. */
export interface WorkerReadyFrame {
  readonly channel: 'rpc'
  readonly type: 'ready'
  readonly protocolVersion: number
  readonly pid: number
}

/** Worker acknowledges initialization. */
export interface WorkerInitializedFrame {
  readonly channel: 'rpc'
  readonly type: 'initialized'
  readonly requestId: string
  readonly pid: number
}

/**
 * Host forwards one unary Remote call as a Connection request envelope. The
 * worker dispatches it through `connection.createSharedFetchHandler('/api')`.
 */
export interface WorkerUnaryRequestFrame {
  readonly channel: 'rpc'
  readonly type: 'request'
  readonly requestId: string
  readonly request: ClientRequest
}

/**
 * Worker returns the raw Fetch result. `body` is base64 because the shared
 * handler can answer with JSON, text, or multipart attachment bytes.
 */
export interface WorkerUnaryResponseFrame {
  readonly channel: 'rpc'
  readonly type: 'response'
  readonly requestId: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** Worker reports that one unary call could not produce a Fetch response. */
export interface WorkerRpcErrorFrame {
  readonly channel: 'rpc'
  readonly type: 'error'
  readonly requestId: string
  readonly error: ConnectionRpcFailure
}

/** Host requests a durable flush, disposal, and process exit. */
export interface WorkerShutdownFrame {
  readonly channel: 'rpc'
  readonly type: 'shutdown'
  readonly requestId: string
}

/** Worker confirms every requested flush completed before disposal starts. */
export interface WorkerShutdownResultFrame {
  readonly channel: 'rpc'
  readonly type: 'shutdown-result'
  readonly requestId: string
  readonly flushedSessions: number
}

/** Host opens one logical Gateway stream on this worker. */
export interface WorkerMuxOpenFrame {
  readonly channel: 'mux'
  readonly type: 'open'
  readonly streamId: string
  readonly endpoint: string
  readonly payload: unknown
}

/** One Client-to-worker uplink item. */
export interface WorkerMuxItemFrame {
  readonly channel: 'mux'
  readonly type: 'item'
  readonly streamId: string
  readonly value?: unknown
}

/** Client half-closes the uplink. */
export interface WorkerMuxEndFrame {
  readonly channel: 'mux'
  readonly type: 'end'
  readonly streamId: string
}

/** Either half cancels one logical stream. */
export interface WorkerMuxCancelFrame {
  readonly channel: 'mux'
  readonly type: 'cancel'
  readonly streamId: string
  readonly reason?: string
}

/** Worker delivers one downlink item. */
export interface WorkerMuxItemDownFrame {
  readonly channel: 'mux'
  readonly type: 'item'
  readonly streamId: string
  readonly value?: unknown
}

/** Worker ends one logical stream normally. */
export interface WorkerMuxEndDownFrame {
  readonly channel: 'mux'
  readonly type: 'end'
  readonly streamId: string
}

/** Worker fails one logical stream with a carrier-safe failure. */
export interface WorkerMuxErrorFrame {
  readonly channel: 'mux'
  readonly type: 'error'
  readonly streamId: string
  readonly error: ConnectionRpcFailure
}

/** Worker lifecycle notification. */
export interface WorkerIdleFrame {
  readonly channel: 'notify'
  readonly type: 'idle'
  readonly idle: boolean
  /** Machine-readable explanation of the observed state. */
  readonly reason: string
  /** Sessions currently attached to this worker. */
  readonly sessions: readonly string[]
}

/** Every frame the host may write. */
export type HostToWorkerFrame =
  | WorkerInitializeFrame
  | WorkerUnaryRequestFrame
  | WorkerShutdownFrame
  | WorkerMuxOpenFrame
  | WorkerMuxItemFrame
  | WorkerMuxEndFrame
  | WorkerMuxCancelFrame

/** Every frame the worker may write. */
export type WorkerToHostFrame =
  | WorkerReadyFrame
  | WorkerInitializedFrame
  | WorkerUnaryResponseFrame
  | WorkerRpcErrorFrame
  | WorkerShutdownResultFrame
  | WorkerMuxItemDownFrame
  | WorkerMuxEndDownFrame
  | WorkerMuxErrorFrame
  | WorkerIdleFrame

/** Either direction. */
export type SessionWorkerFrame = HostToWorkerFrame | WorkerToHostFrame

/**
 * Endpoints that observe durable or live state without producing work. Opening
 * or reading one must not postpone the host's idle shutdown timer.
 */
export const PASSIVE_STREAM_ENDPOINTS: ReadonlySet<string> = new Set([
  'session/follow',
  'session/control',
  '$events',
])

/**
 * Test whether one stream endpoint is passive.
 * @param endpoint - exact Remote endpoint name.
 * @returns true when the stream must not count as worker activity.
 */
export function isPassiveStreamEndpoint(endpoint: string): boolean {
  return PASSIVE_STREAM_ENDPOINTS.has(endpoint)
}

/**
 * Serialize one frame as a newline-terminated JSON line.
 * @param frame - frame to encode.
 * @returns UTF-8 text including the terminator.
 * @throws {SessionWorkerProtocolError} when the frame cannot be JSON-encoded.
 */
export function encodeFrame(frame: SessionWorkerFrame): string {
  let line: string
  try {
    line = JSON.stringify(frame)
  } catch (error) {
    throw new SessionWorkerProtocolError('frame is not JSON-serializable', { cause: error })
  }
  return `${line}\n`
}

/**
 * Parse one complete JSON line.
 * @param line - line without its terminator.
 * @returns the validated frame.
 * @throws {SessionWorkerProtocolError} when the line is not a known frame.
 */
export function parseFrameLine(line: string): SessionWorkerFrame {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch (error) {
    throw new SessionWorkerProtocolError('frame is not JSON', { cause: error })
  }
  const record = asRecord(value, 'frame')
  switch (record['channel']) {
    case 'rpc':
      return parseRpcFrame(record)
    case 'mux':
      return parseMuxFrame(record)
    case 'notify':
      return parseNotifyFrame(record)
    default:
      throw new SessionWorkerProtocolError(`unknown frame channel ${JSON.stringify(record['channel'])}`)
  }
}

/**
 * Prove that a parsed frame belongs to the host-to-worker direction.
 * @param frame - frame from {@link parseFrameLine}.
 * @returns the same frame narrowed to the host direction.
 * @throws {SessionWorkerProtocolError} for a worker-originated frame.
 */
export function asHostToWorkerFrame(frame: SessionWorkerFrame): HostToWorkerFrame {
  switch (frame.channel) {
    case 'rpc':
      switch (frame.type) {
        case 'initialize':
        case 'request':
        case 'shutdown':
          return frame
        default:
          break
      }
      break
    case 'mux':
      switch (frame.type) {
        case 'open':
        case 'item':
        case 'end':
        case 'cancel':
          return frame
        default:
          break
      }
      break
    case 'notify':
      break
  }
  throw new SessionWorkerProtocolError(
    `worker sent a frame the host never sends: ${JSON.stringify(frame.channel)}/${JSON.stringify(frame.type)}`,
  )
}

/**
 * Prove that a parsed frame belongs to the worker-to-host direction.
 * @param frame - frame from {@link parseFrameLine}.
 * @returns the same frame narrowed to the worker direction.
 * @throws {SessionWorkerProtocolError} for a host-originated frame.
 */
export function asWorkerToHostFrame(frame: SessionWorkerFrame): WorkerToHostFrame {
  switch (frame.channel) {
    case 'rpc':
      switch (frame.type) {
        case 'ready':
        case 'initialized':
        case 'response':
        case 'error':
        case 'shutdown-result':
          return frame
        default:
          break
      }
      break
    case 'mux':
      switch (frame.type) {
        case 'item':
        case 'end':
        case 'error':
          return frame
        default:
          break
      }
      break
    case 'notify':
      return frame
  }
  throw new SessionWorkerProtocolError(
    `host sent a frame the worker never sends: ${JSON.stringify(frame.channel)}/${JSON.stringify(frame.type)}`,
  )
}

/**
 * Incremental decoder for a newline-delimited byte stream.
 *
 * Chunks are string-decoded by the caller (`stream.setEncoding('utf8')`) so a
 * multi-byte code point is never split here by the decoder itself.
 */
export class SessionWorkerFrameDecoder {
  private buffered = ''

  /**
   * @param maxFrameBytes - maximum UTF-8 size of one complete line.
   */
  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError(`session-worker: max frame bytes must be a positive integer, got ${JSON.stringify(maxFrameBytes)}`)
    }
  }

  /**
   * Accept one chunk and return every complete frame it finished.
   * @param chunk - decoded text chunk.
   * @returns validated frames in wire order.
   * @throws {SessionWorkerProtocolError} when a line is oversized or invalid.
   */
  push(chunk: string): SessionWorkerFrame[] {
    this.buffered += chunk
    const frames: SessionWorkerFrame[] = []
    let boundary = this.buffered.indexOf('\n')
    while (boundary !== -1) {
      const line = this.buffered.slice(0, boundary)
      this.buffered = this.buffered.slice(boundary + 1)
      if (line.trim() !== '') {
        this.assertSize(line)
        frames.push(parseFrameLine(line))
      }
      boundary = this.buffered.indexOf('\n')
    }
    this.assertSize(this.buffered)
    return frames
  }

  /**
   * Finish the stream, rejecting a truncated trailing frame.
   * @throws {SessionWorkerProtocolError} when bytes remain without a terminator.
   */
  end(): void {
    if (this.buffered.trim() !== '') {
      throw new SessionWorkerProtocolError('control channel ended with a truncated frame')
    }
    this.buffered = ''
  }

  private assertSize(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      throw new SessionWorkerProtocolError(`frame exceeds ${String(this.maxFrameBytes)} bytes`)
    }
  }
}

/**
 * Encode bytes for a JSON frame field.
 * @param bytes - arbitrary response or request bytes.
 * @returns base64 text.
 */
export function encodeBody(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/**
 * Decode a base64 frame field.
 * @param body - base64 text produced by {@link encodeBody}.
 * @returns the original bytes.
 */
export function decodeBody(body: string): Uint8Array {
  return new Uint8Array(Buffer.from(body, 'base64'))
}

function parseRpcFrame(record: Record<string, unknown>): SessionWorkerFrame {
  switch (record['type']) {
    case 'initialize': {
      const payload = asRecord(record['payload'], 'initialize.payload')
      return {
        channel: 'rpc',
        type: 'initialize',
        requestId: readString(record, 'requestId'),
        payload: {
          cwd: readString(payload, 'cwd'),
          sessionIds: readStringArray(payload, 'sessionIds'),
        },
      }
    }
    case 'ready':
      return {
        channel: 'rpc',
        type: 'ready',
        protocolVersion: readInteger(record, 'protocolVersion'),
        pid: readInteger(record, 'pid'),
      }
    case 'initialized':
      return {
        channel: 'rpc',
        type: 'initialized',
        requestId: readString(record, 'requestId'),
        pid: readInteger(record, 'pid'),
      }
    case 'request': {
      const request = asRecord(record['request'], 'request')
      if (request['type'] !== 'client-request') {
        throw new SessionWorkerProtocolError('request envelope must be a client-request')
      }
      if (!Object.hasOwn(request, 'payload')) {
        throw new SessionWorkerProtocolError('request envelope is missing payload')
      }
      return {
        channel: 'rpc',
        type: 'request',
        requestId: readString(record, 'requestId'),
        request: {
          type: 'client-request',
          rpcId: readString(request, 'rpcId') as ClientRequest['rpcId'],
          method: readString(request, 'method'),
          payload: request['payload'],
        },
      }
    }
    case 'response':
      return {
        channel: 'rpc',
        type: 'response',
        requestId: readString(record, 'requestId'),
        status: readInteger(record, 'status'),
        headers: readStringRecord(record['headers'], 'headers'),
        body: readString(record, 'body'),
      }
    case 'error':
      return {
        channel: 'rpc',
        type: 'error',
        requestId: readString(record, 'requestId'),
        error: readFailure(record['error']),
      }
    case 'shutdown':
      return {
        channel: 'rpc',
        type: 'shutdown',
        requestId: readString(record, 'requestId'),
      }
    case 'shutdown-result':
      return {
        channel: 'rpc',
        type: 'shutdown-result',
        requestId: readString(record, 'requestId'),
        flushedSessions: readInteger(record, 'flushedSessions'),
      }
    default:
      throw new SessionWorkerProtocolError(`unknown rpc frame type ${JSON.stringify(record['type'])}`)
  }
}

function parseMuxFrame(record: Record<string, unknown>): SessionWorkerFrame {
  switch (record['type']) {
    case 'open':
      return {
        channel: 'mux',
        type: 'open',
        streamId: readString(record, 'streamId'),
        endpoint: readString(record, 'endpoint'),
        payload: record['payload'],
      }
    case 'item':
      return {
        channel: 'mux',
        type: 'item',
        streamId: readString(record, 'streamId'),
        ...Object.hasOwn(record, 'value') ? { value: record['value'] } : {},
      }
    case 'end':
      return {
        channel: 'mux',
        type: 'end',
        streamId: readString(record, 'streamId'),
      }
    case 'cancel':
      return {
        channel: 'mux',
        type: 'cancel',
        streamId: readString(record, 'streamId'),
        ...Object.hasOwn(record, 'reason') ? { reason: readString(record, 'reason') } : {},
      }
    case 'error':
      return {
        channel: 'mux',
        type: 'error',
        streamId: readString(record, 'streamId'),
        error: readFailure(record['error']),
      }
    default:
      throw new SessionWorkerProtocolError(`unknown mux frame type ${JSON.stringify(record['type'])}`)
  }
}

function parseNotifyFrame(record: Record<string, unknown>): SessionWorkerFrame {
  if (record['type'] !== 'idle') {
    throw new SessionWorkerProtocolError(`unknown notify frame type ${JSON.stringify(record['type'])}`)
  }
  if (typeof record['idle'] !== 'boolean') {
    throw new SessionWorkerProtocolError('notify.idle must be a boolean')
  }
  return {
    channel: 'notify',
    type: 'idle',
    idle: record['idle'],
    reason: readString(record, 'reason'),
    sessions: readStringArray(record, 'sessions'),
  }
}

function readFailure(value: unknown): ConnectionRpcFailure {
  const record = asRecord(value, 'error')
  const details = asRecord(record['details'], 'error.details')
  return {
    code: readString(record, 'code'),
    message: readString(record, 'message'),
    details,
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionWorkerProtocolError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SessionWorkerProtocolError(`${field} must be a non-empty string`)
  }
  return value
}

function readInteger(record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SessionWorkerProtocolError(`${field} must be a safe integer`)
  }
  return value
}

function readStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = record[field]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new SessionWorkerProtocolError(`${field} must be an array of strings`)
  }
  return value
}

function readStringRecord(value: unknown, field: string): Record<string, string> {
  const record = asRecord(value, field)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') {
      throw new SessionWorkerProtocolError(`${field}.${key} must be a string`)
    }
    result[key] = entry
  }
  return result
}

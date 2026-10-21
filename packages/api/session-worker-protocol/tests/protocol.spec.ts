import { describe, expect, it } from 'vitest'
import {
  AsyncQueue,
  AsyncQueueOverflowError,
  SessionWorkerFrameDecoder,
  SessionWorkerProtocolError,
  asHostToWorkerFrame,
  asWorkerToHostFrame,
  decodeBody,
  encodeBody,
  encodeFrame,
  isPassiveStreamEndpoint,
  parseFrameLine,
  type HostToWorkerFrame,
  type WorkerToHostFrame,
} from '../src/index.ts'

const request: HostToWorkerFrame = {
  channel: 'rpc',
  type: 'request',
  requestId: 'rpc-1',
  request: {
    type: 'client-request',
    rpcId: 'rpc-1' as never,
    method: 'session/prompt',
    payload: { sessionId: 'session-1' },
  },
}

describe('session worker frames', () => {
  it('round-trips every host and worker frame shape', () => {
    const frames: (HostToWorkerFrame | WorkerToHostFrame)[] = [
      { channel: 'rpc', type: 'ready', protocolVersion: 1, pid: 42 },
      {
        channel: 'rpc',
        type: 'initialize',
        requestId: 'init-1',
        payload: { cwd: '/tmp/work', sessionIds: ['session-1'] },
      },
      { channel: 'rpc', type: 'initialized', requestId: 'init-1', pid: 42 },
      request,
      {
        channel: 'rpc',
        type: 'response',
        requestId: 'rpc-1',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: encodeBody(new TextEncoder().encode('{"ok":true}')),
      },
      {
        channel: 'rpc',
        type: 'error',
        requestId: 'rpc-2',
        error: { code: 'gateway/internal', message: 'failed', details: {} },
      },
      { channel: 'rpc', type: 'shutdown', requestId: 'shutdown-1' },
      { channel: 'rpc', type: 'shutdown-result', requestId: 'shutdown-1', flushedSessions: 1 },
      {
        channel: 'rpc',
        type: 'host-call',
        requestId: 'call-1',
        service: 'schedule',
        method: 'list',
        payload: { request: { sessionId: 'session-1' } },
      },
      {
        channel: 'rpc',
        type: 'host-call-result',
        requestId: 'call-1',
        result: { ok: true, value: { items: [] } },
      },
      { channel: 'mux', type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: {} } },
      { channel: 'mux', type: 'item', streamId: 's1', value: { hello: 'world' } },
      { channel: 'mux', type: 'item', streamId: 's1' },
      { channel: 'mux', type: 'end', streamId: 's1' },
      { channel: 'mux', type: 'cancel', streamId: 's1', reason: 'done' },
      { channel: 'mux', type: 'cancel', streamId: 's1' },
      {
        channel: 'mux',
        type: 'error',
        streamId: 's1',
        error: { code: 'gateway/protocol', message: 'bad', details: {} },
      },
      { channel: 'notify', type: 'idle', idle: true, reason: 'quiet', sessions: ['session-1'] },
    ]
    for (const frame of frames) {
      expect(parseFrameLine(encodeFrame(frame).trimEnd())).toEqual(frame)
    }
  })

  it('keeps reverse calls and their results on their own sides', () => {
    const call = {
      channel: 'rpc', type: 'host-call', requestId: 'call-1',
      service: 'schedule', method: 'list', payload: {},
    } as const
    const result = {
      channel: 'rpc', type: 'host-call-result', requestId: 'call-1', result: { ok: true, value: null },
    } as const
    expect(asWorkerToHostFrame(call)).toBe(call)
    expect(asHostToWorkerFrame(result)).toBe(result)
    expect(() => asHostToWorkerFrame(call)).toThrow(SessionWorkerProtocolError)
    expect(() => asWorkerToHostFrame(result)).toThrow(SessionWorkerProtocolError)
  })

  it('decodes frames split across arbitrary chunks and ignores blank lines', () => {
    const decoder = new SessionWorkerFrameDecoder()
    const line = encodeFrame(request).trimEnd()
    expect(decoder.push(line.slice(0, 10))).toEqual([])
    expect(decoder.push(line.slice(10, 25))).toEqual([])
    expect(decoder.push(line.slice(25))).toEqual([])
    expect(decoder.push('\n')).toEqual([request])
    expect(decoder.push('\n')).toEqual([])
    decoder.end()
  })

  it('rejects a truncated trailing frame', () => {
    const decoder = new SessionWorkerFrameDecoder()
    decoder.push('{"channel":"rpc"')
    expect(() => { decoder.end() }).toThrow(SessionWorkerProtocolError)
  })

  it('rejects oversized, malformed, and unknown frames', () => {
    expect(() => parseFrameLine('not json')).toThrow(SessionWorkerProtocolError)
    expect(() => parseFrameLine('{"channel":"other","type":"x"}')).toThrow(SessionWorkerProtocolError)
    expect(() => parseFrameLine('{"channel":"rpc","type":"mystery"}')).toThrow(SessionWorkerProtocolError)
    expect(() => parseFrameLine('{"channel":"notify","type":"idle","idle":"yes"}')).toThrow(SessionWorkerProtocolError)
    const decoder = new SessionWorkerFrameDecoder(8)
    expect(() => decoder.push(`${JSON.stringify(request)}\n`)).toThrow(/exceeds/)
  })

  it('round-trips binary response bodies', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    expect(decodeBody(encodeBody(bytes))).toEqual(bytes)
  })

  it('classifies only observation streams as passive', () => {
    expect(isPassiveStreamEndpoint('session/follow')).toBe(true)
    expect(isPassiveStreamEndpoint('session/control')).toBe(true)
    expect(isPassiveStreamEndpoint('$events')).toBe(true)
    expect(isPassiveStreamEndpoint('session/prompt')).toBe(false)
  })
})

describe('async queue', () => {
  it('delivers buffered values, including undefined', async () => {
    const queue = new AsyncQueue<unknown>(4)
    queue.push(1)
    queue.push(undefined)
    queue.end()
    expect(await queue.next()).toEqual({ done: false, value: 1 })
    expect(await queue.next()).toEqual({ done: false, value: undefined })
    expect(await queue.next()).toEqual({ done: true, value: undefined })
  })

  it('delivers to a waiting consumer', async () => {
    const queue = new AsyncQueue<number>(1)
    const next = queue.next()
    queue.push(7)
    expect(await next).toEqual({ done: false, value: 7 })
  })

  it('rejects overflow and recorded failures', async () => {
    const queue = new AsyncQueue<number>(1)
    queue.push(1)
    expect(() => { queue.push(2) }).toThrow(AsyncQueueOverflowError)
    const failed = new AsyncQueue<number>(1)
    failed.fail(new Error('boom'))
    await expect(failed.next()).rejects.toThrow('boom')
  })
})

/** A crashed worker rejects in-flight work and the next acquire spawns a fresh process. */

import { PassThrough, Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SESSION_WORKER_PROTOCOL_VERSION,
  encodeFrame,
} from '@deepseek-ai/dsh-session-worker-protocol'
import { SessionWorkerSupervisor } from '../src/index.ts'

const sessionId = 'session-crash' as SessionId
const contexts: Context[] = []
let nextPid = 1

afterEach(async () => {
  for (const ctx of contexts.splice(0)) { await ctx.fiber.dispose() }
  nextPid = 1
})

/** In-process stand-in for a worker process and its fd 7 control channel. */
class FakeChild {
  readonly pid = nextPid++
  /** Frames the supervisor wrote, as UTF-8 lines. */
  private readonly hostWrites = new PassThrough()
  /** Frames this fake worker sends to the supervisor. */
  private readonly workerWrites = new PassThrough()
  readonly control: Duplex = Duplex.from({ readable: this.workerWrites, writable: this.hostWrites })
  private readonly exited = Promise.withResolvers<boolean>()
  private readonly done = Promise.withResolvers<unknown>()
  private buffer = ''
  ended = false

  constructor() {
    this.hostWrites.setEncoding('utf8')
    this.hostWrites.on('data', (chunk: string) => { this.receive(chunk) })
    // The supervisor attaches its listeners after `spawn` returns.
    setImmediate(() => {
      this.send({ channel: 'rpc', type: 'ready', protocolVersion: SESSION_WORKER_PROTOCOL_VERSION, pid: this.pid })
      this.send({ channel: 'rpc', type: 'initialized', requestId: `ready-${String(this.pid)}`, pid: this.pid })
    })
  }

  readonly handle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: this.control,
    collected: {},
    done: this.done.promise,
    terminate: (): void => { this.exit() },
    waitForExit: (signal?: AbortSignal): Promise<boolean> => this.wait(signal),
  }

  private wait(signal?: AbortSignal): Promise<boolean> {
    if (this.ended) return Promise.resolve(true)
    if (signal === undefined) return this.exited.promise
    return Promise.race([
      this.exited.promise,
      new Promise<boolean>((resolve) => {
        if (signal.aborted) resolve(false)
        else signal.addEventListener('abort', () => { resolve(false) }, { once: true })
      }),
    ])
  }

  send(frame: unknown): void {
    this.workerWrites.write(encodeFrame(frame as never))
  }

  exit(): void {
    if (this.ended) return
    this.ended = true
    this.workerWrites.end()
    this.hostWrites.end()
    this.exited.resolve(true)
    this.done.resolve({ exitCode: 0, signal: null })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const frame = JSON.parse(line) as { readonly channel?: string; readonly type?: string; readonly requestId?: string }
      if (frame.channel === 'rpc' && frame.type === 'shutdown') {
        this.send({ channel: 'rpc', type: 'shutdown-result', requestId: frame.requestId, flushedSessions: 0 })
        setImmediate(() => { this.exit() })
      }
    }
  }
}

async function setup(): Promise<{ ctx: Context; supervisor: SessionWorkerSupervisor; children: FakeChild[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const children: FakeChild[] = []
  ctx.provide('subprocess', {
    spawn: () => {
      const child = new FakeChild()
      children.push(child)
      return child.handle
    },
  } as never)
  await ctx.plugin(SessionWorkerSupervisor, {
    command: ['fake-worker'],
    cwd: '/tmp',
    idleTimeoutMs: 0,
    readyTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    graceMs: 2_000,
  })
  return { ctx, supervisor: ctx.sessionWorkers, children }
}

describe('Session worker crash', () => {
  it('rejects an in-flight unary call, marks the exit as a crash, and respawns on demand', async () => {
    const { supervisor, children } = await setup()
    const first = await supervisor.acquire(sessionId)
    expect(first.pid).toBe(1)
    expect(first.crashed).toBe(false)

    const pending = first.call('session/page', { request: {} })
    const child = children[0] as FakeChild
    child.exit()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-worker/unavailable' },
    })
    await first.exited
    expect(first.crashed).toBe(true)
    expect(supervisor.get(sessionId)).toBeUndefined()

    const second = await supervisor.acquire(sessionId)
    expect(second.pid).toBe(2)
    expect(second).not.toBe(first)
    expect(second.crashed).toBe(false)

    await second.shutdown()
    expect(second.crashed).toBe(false)
    expect(children[1]?.ended).toBe(true)
  })
})

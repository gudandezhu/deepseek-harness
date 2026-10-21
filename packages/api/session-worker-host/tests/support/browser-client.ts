/**
 * Browser-facing test client for a real Web host subprocess: the announced URL,
 * cookie authentication, unary RPC, and the Gateway mux stream.
 */

import type { ChildProcess } from 'node:child_process'
import WebSocket, { type RawData } from 'ws'

/** Frame the host writes for one unary client request. */
export interface ServerResponseEnvelope {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
}

/** Wait until the host prints the `dsh web: <url>` line. */
export function announcedUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`web host did not announce its URL; output:\n${output}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      const match = /dsh web: (http:\/\/\S+)/.exec(output)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      resolve(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`web host exited with ${String(code)}; output:\n${output}`))
    })
  })
}

/** Request the browser cookie the host issues on the root page. */
export async function authenticate(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie()[0]
    ?? response.headers.get('set-cookie')
    ?? undefined
  if (setCookie === undefined) throw new Error(`web host did not issue a browser cookie (${String(response.status)})`)
  return setCookie.split(';', 1)[0] as string
}

/** Dispatch one unary Remote call over the `/api` Fetch surface. */
export async function requestRpc(
  origin: string,
  cookie: string,
  endpoint: string,
  args: Record<string, unknown>,
): Promise<ServerResponseEnvelope['result']> {
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `rpc-${endpoint}-${Date.now()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  const envelope = await response.json() as ServerResponseEnvelope
  return envelope.result
}

export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Default wait for the next frame when the caller has no tighter budget. */
const DEFAULT_STREAM_TIMEOUT_MS = 180_000

/** One logical browser stream over the Gateway mux. */
export class StreamReader {
  private readonly items: unknown[] = []
  private wake: (() => void) | undefined
  private failure: Error | undefined
  private ended = false

  push(value: unknown): void {
    this.items.push(value)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: Error): void {
    this.failure = error
    this.wake?.()
    this.wake = undefined
  }

  end(): void {
    this.ended = true
    this.wake?.()
    this.wake = undefined
  }

  async next(timeoutMs: number = DEFAULT_STREAM_TIMEOUT_MS): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.items.length > 0) return this.items.shift()
      if (this.failure !== undefined) throw this.failure
      if (this.ended) throw new Error('stream ended before the expected frame')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('stream frame timed out')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.wake = undefined
          reject(new Error('stream frame timed out'))
        }, remaining)
        this.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return data.toString('utf8')
}

/** WebSocket mux client that unwraps one logical stream per id. */
export class MuxClient {
  private readonly readers = new Map<string, StreamReader>()
  private counter = 0

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      const message = JSON.parse(rawText(data)) as {
        type: string
        streamId: string
        value?: unknown
        error?: { code: string; message: string }
      }
      const reader = this.readers.get(message.streamId)
      if (reader === undefined) return
      if (message.type === 'item') reader.push(message.value)
      else if (message.type === 'end') reader.end()
      else if (message.type === 'error') reader.fail(new Error(`${message.error?.code ?? 'stream'}: ${message.error?.message ?? ''}`))
    })
  }

  static async connect(origin: string, cookie: string): Promise<MuxClient> {
    const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/remote.mux`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    return new MuxClient(socket)
  }

  get readyState(): number {
    return this.socket.readyState
  }

  open(endpoint: string, args: Record<string, unknown>): StreamReader {
    const streamId = `stream-${++this.counter}`
    const reader = new StreamReader()
    this.readers.set(streamId, reader)
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    return reader
  }

  close(): void {
    this.socket.terminate()
  }
}

/**
 * Stage-two end-to-end proof over the real Web Host and a mock model:
 * creating and prompting a Session runs its Agent in a worker, the browser
 * follow stream survives the worker's idle exit, the next prompt resumes in a
 * fresh worker with history, cursor, projections, and a reset frame intact,
 * and the worker process disappears after each idle reclaim.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cliEntry = join(repositoryRoot, 'apps/cli/src/bin.ts')
const MOCK_TEXT = 'mock reply from a session worker'
const IDLE_TTL_MS = 1_500
const UI_TIMEOUT_MS = 180_000

interface ServerResponseEnvelope {
  readonly type: 'server-response'
  readonly rpcId: string
  readonly result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
}

interface FollowSnapshot {
  readonly type: 'snapshot' | 'reset'
  readonly header: { readonly id: string }
  readonly cursor: number
  readonly records: readonly { readonly type: 'event'; readonly event: { readonly type: string; readonly data: unknown } }[]
  readonly hasMore: boolean
  readonly projections: { readonly asOfSeq: number; readonly values: Record<string, unknown> }
}

interface FollowEvent {
  readonly type: 'event'
  readonly event: { readonly type: string; readonly data: unknown }
}

type FollowFrame = FollowSnapshot | FollowEvent | { readonly type: 'assistant-stream' }

let server: MockLlmServer
let home: string
let project: string
let host: ChildProcess
let origin: string
let cookie: string
let mux: MuxClient

beforeAll(async () => {
  server = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: MOCK_TEXT,
  })
  home = await mkdtemp(join(tmpdir(), 'dsh-session-worker-host-home-'))
  project = await mkdtemp(join(tmpdir(), 'dsh-session-worker-host-project-'))
  host = spawn(process.execPath, ['--import', 'tsx/esm', cliEntry, 'web', '--no-open', '--port', '0'], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_SESSION_WORKER_IDLE_MS: String(IDLE_TTL_MS),
      DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (process.env.DSH_E2E_DEBUG === '1') {
    host.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`[worker-host stderr] ${chunk.toString('utf8')}`) })
    host.stdout?.on('data', (chunk: Buffer) => { process.stderr.write(`[worker-host stdout] ${chunk.toString('utf8')}`) })
  }
  const url = await announcedUrl(host)
  origin = new URL(url).origin
  cookie = await authenticate(url)
  mux = await MuxClient.connect(origin, cookie)
}, 240_000)

afterAll(async () => {
  mux?.close()
  host?.kill('SIGTERM')
  await server?.close()
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('web host session workers', () => {
  it('keeps the browser stream across idle exits and resumes with correct state', async () => {
    const baselineRss = rssKb(host.pid as number)

    const created = await rpc('session/create', { request: { cwd: project } })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const sessionId = (created as { ok: true; value: { sessionId: string } }).value.sessionId
    expect(sessionId).toMatch(/^session-/)

    const follow = mux.open('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 100,
      },
    })
    const snapshot = await follow.next() as FollowSnapshot
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.header.id).toBe(sessionId)

    const firstPrompt = await rpc('session/prompt', {
      request: {
        requestId: `request-${sessionId}-1`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'first turn' }],
      },
    })
    expect(firstPrompt.ok, JSON.stringify(firstPrompt)).toBe(true)
    const firstTurn = await collectTurn(follow)
    expect(firstTurn.assistant).toContain(MOCK_TEXT)

    const firstWorker = await waitForSingleWorker(host.pid as number)
    const firstWorkerPid = firstWorker.pid
    expect(firstWorkerPid).toBeGreaterThan(0)
    await waitForNoChildren(host.pid as number, UI_TIMEOUT_MS)
    expect(isAlive(firstWorkerPid)).toBe(false)
    expect(mux.readyState).toBe(WebSocket.OPEN)

    const secondPrompt = await rpc('session/prompt', {
      request: {
        requestId: `request-${sessionId}-2`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'second turn' }],
      },
    })
    expect(secondPrompt.ok, JSON.stringify(secondPrompt)).toBe(true)

    const reset = await follow.next() as FollowSnapshot
    expect(reset.type).toBe('reset')
    expect(reset.records.map(record => JSON.stringify(record.event.data)).join('\n')).toContain(MOCK_TEXT)
    expect(reset.projections.asOfSeq).toBeGreaterThanOrEqual(0)

    const secondTurn = await collectTurn(follow)
    expect(secondTurn.assistant).toContain(MOCK_TEXT)

    const firstTurnEnd = [...reset.records].reverse()
      .find(record => record.event.type === 'turn/end')
    expect(firstTurnEnd).toBeDefined()

    const page = await rpc('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq: reset.cursor,
        maxMessages: 100,
      },
    })
    expect(page.ok, JSON.stringify(page)).toBe(true)
    expect(JSON.stringify((page as { ok: true; value: unknown }).value)).toContain(MOCK_TEXT)

    const secondWorker = await waitForSingleWorker(host.pid as number)
    expect(secondWorker.pid).not.toBe(firstWorkerPid)
    await waitForNoChildren(host.pid as number, UI_TIMEOUT_MS)
    expect(isAlive(secondWorker.pid)).toBe(false)
    expect(mux.readyState).toBe(WebSocket.OPEN)

    const settledRss = rssKb(host.pid as number)
    expect(settledRss).toBeLessThan(baselineRss + 120_000)
  }, 600_000)
})

async function rpc(endpoint: string, args: Record<string, unknown>): Promise<ServerResponseEnvelope['result']> {
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

async function collectTurn(reader: StreamReader): Promise<{ readonly assistant: string }> {
  const parts: string[] = []
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const frame = await reader.next(deadline - Date.now()) as FollowFrame
    if (frame.type !== 'event') continue
    if (frame.event.type === 'assistant/message') parts.push(JSON.stringify(frame.event.data))
    if (frame.event.type === 'turn/end') return { assistant: parts.join('\n') }
  }
  throw new Error('turn did not finish before the deadline')
}

function announcedUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`web host did not announce its URL; output:\n${output}`))
    }, UI_TIMEOUT_MS)
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

async function authenticate(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie()[0]
    ?? response.headers.get('set-cookie')
  if (setCookie === undefined) throw new Error(`web host did not issue a browser cookie (${String(response.status)})`)
  return setCookie.split(';', 1)[0] as string
}

interface ChildProcessInfo {
  readonly pid: number
  readonly rssKb: number
  readonly command: string
}

function children(pid: number): ChildProcessInfo[] {
  let output: string
  try {
    output = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
  } catch {
    return []
  }
  return output.trim().split('\n').filter(Boolean).map((line) => {
    const childPid = Number(line.trim())
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(childPid)], { encoding: 'utf8' }).trim()
    return { pid: childPid, rssKb: rssKb(childPid), command }
  })
}

function sessionWorkers(pid: number): ChildProcessInfo[] {
  return children(pid).filter(child => child.command.includes('--profile session-worker'))
}

async function waitForSingleWorker(hostPid: number): Promise<ChildProcessInfo> {
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const live = sessionWorkers(hostPid)
    if (live.length === 1) return live[0] as ChildProcessInfo
    if (live.length > 1) throw new Error(`expected one worker, found ${String(live.length)}: ${live.map(entry => `${entry.pid}:${entry.command}`).join(' | ')}`)
    await delay(250)
  }
  throw new Error('a session worker never appeared')
}

async function waitForNoChildren(hostPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (sessionWorkers(hostPid).length === 0) return
    await delay(250)
  }
  throw new Error(`session worker did not exit within ${String(timeoutMs)}ms`)
}

function rssKb(pid: number): number {
  const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  return Number(output)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** One logical browser stream over the Gateway mux. */
class StreamReader {
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

  async next(timeoutMs: number = UI_TIMEOUT_MS): Promise<unknown> {
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

/** WebSocket mux client that unwraps one logical stream per id. */
class MuxClient {
  private readonly readers = new Map<string, StreamReader>()
  private counter = 0

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => {
      const message = JSON.parse(data.toString()) as {
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

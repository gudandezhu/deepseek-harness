/**
 * Stage-two end-to-end proof over the real Web Host and a mock model:
 * creating and prompting a Session runs its Agent in a worker, the browser
 * follow stream survives the worker's idle exit, the next prompt resumes in a
 * fresh worker with history, cursor, projections, and a reset frame intact,
 * and the worker process disappears after each idle reclaim.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import {
  announcedUrl,
  authenticate,
  delay,
  MuxClient,
  requestRpc,
  StreamReader,
  type ServerResponseEnvelope,
} from './support/browser-client.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cliEntry = join(repositoryRoot, 'apps/cli/src/bin.ts')
const MOCK_TEXT = 'mock reply from a session worker'
const APPROVAL_FILE_TEXT = 'hello from the approval fixture'
const IDLE_TTL_MS = 1_500
const UI_TIMEOUT_MS = 180_000

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
  home = await mkdtemp(join(tmpdir(), 'dsh-session-worker-host-home-'))
  project = await mkdtemp(join(tmpdir(), 'dsh-session-worker-host-project-'))
  const approvalFile = join(project, 'approval.txt')
  await writeFile(approvalFile, APPROVAL_FILE_TEXT)
  // A test-only tool gate: every `read` asks the browser, everything else
  // keeps the stock decision. It loads in both the Host and the worker because
  // the Host forwards its `--patch` overlays.
  const fixture = join(home, 'approval-fixture.mjs')
  await writeFile(fixture, [
    "export const name = 'e2e-approval-fixture'",
    'export function apply(ctx) {',
    "  ctx.on('tools/pre-execute', async (exec, next) =>",
    "    exec.name === 'read' ? { kind: 'ask', reason: 'e2e approval' } : next())",
    '}',
    '',
  ].join('\n'))
  const patch = join(home, 'approval.patch.yml')
  await writeFile(patch, [
    // Title generation issues its own auxiliary model request; this suite
    // scripts exact model responses, so keep request order deterministic.
    '- id: session-title-llm',
    '  disabled: true',
    '- insert:',
    '    - id: e2e-approval',
    `      name: ${JSON.stringify(fixture)}`,
    '',
  ].join('\n'))
  server = await startMockLlmServer({
    apiKey: 'mock-key',
    // The first request asks for a tool call; the follow-up request returns text.
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: MOCK_TEXT,
    toolName: 'read',
    toolArguments: JSON.stringify({ file_path: approvalFile }),
  })
  // The launcher accepts `--profile` and `--patch` together; app flags follow.
  host = spawn(process.execPath, [
    '--import', 'tsx/esm', cliEntry, '--profile', 'web', '--patch', patch, '--no-open', '--port', '0',
  ], {
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
  const url = await announcedUrl(host, UI_TIMEOUT_MS)
  origin = new URL(url).origin
  cookie = await authenticate(url)
  mux = await MuxClient.connect(origin, cookie)
}, 240_000)

afterAll(async () => {
  mux?.close()
  if (host !== undefined && host.exitCode === null && host.signalCode === null) {
    const exited = new Promise<void>((resolve) => { host.once('exit', () => { resolve() }) })
    host.kill('SIGTERM')
    await exited
  }
  await server?.close()
  const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const
  await rm(home, retry)
  await rm(project, retry)
})

describe('web host session workers', () => {
  it('asks an approval inside the worker, answers in the browser, and continues the tool', async () => {
    const events = mux.open('$events', {})
    const ready = await events.next() as { readonly type: 'ready'; readonly clientId: string }
    expect(ready.type).toBe('ready')

    const created = await rpc('session/create', { request: { cwd: project } })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const sessionId = (created as { ok: true; value: { sessionId: string } }).value.sessionId

    const follow = mux.open('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 100,
      },
    })
    const snapshot = await follow.next() as FollowSnapshot
    expect(snapshot.type).toBe('snapshot')

    const prompted = await rpc('session/prompt', {
      request: {
        requestId: `request-${sessionId}-approval`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'read the approval file' }],
      },
    })
    expect(prompted.ok, JSON.stringify(prompted)).toBe(true)

    const waterfall = await waitForWaterfall(events)
    expect(waterfall.event).toBe('approval/request')
    expect(waterfall.request).toMatchObject({ toolName: 'read' })

    const answered = await rpc('$events/result', {
      clientId: ready.clientId,
      eventId: waterfall.eventId,
      outcome: { kind: 'result', value: 'allowed-once' },
    })
    expect(answered.ok, JSON.stringify(answered)).toBe(true)

    const turn = await collectTurn(follow)

    expect(turn.tools).toContain(APPROVAL_FILE_TEXT)
    expect(turn.assistant).toContain(MOCK_TEXT)
  }, 600_000)

  it('resolves an upload receipt in the worker that resumes after an idle exit', async () => {
    await waitForNoChildren(host.pid as number, 20_000)
    const created = await rpc('session/create', { request: { cwd: project } })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const sessionId = (created as { ok: true; value: { sessionId: string } }).value.sessionId
    const firstWorker = await waitForSingleWorker(host.pid as number)

    // The browser uploads against the Host while the Agent lives in worker A.
    const response = await fetch(
      `${origin}/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=approval.txt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', cookie },
        body: APPROVAL_FILE_TEXT,
      },
    )
    const uploaded = await response.json() as {
      readonly ok: boolean
      readonly value?: { readonly receiptId: string; readonly file: { readonly attachmentId: string } }
    }
    expect(uploaded.ok, JSON.stringify(uploaded)).toBe(true)
    const receipt = uploaded.value
    if (receipt === undefined) throw new Error('upload returned no receipt')

    // Worker A leaves without consuming the receipt.
    await waitForNoChildren(host.pid as number, 30_000)
    expect(isAlive(firstWorker.pid)).toBe(false)

    const follow = mux.open('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 100,
      },
    })
    const prompted = await rpc('session/prompt', {
      request: {
        requestId: `request-${sessionId}-upload`,
        sessionId,
        mode: 'queue',
        content: [
          { type: 'file', receiptId: receipt.receiptId },
          { type: 'text', text: 'use the uploaded file' },
        ],
      },
    })
    expect(prompted.ok, JSON.stringify(prompted)).toBe(true)

    const secondWorker = await waitForSingleWorker(host.pid as number)
    expect(secondWorker.pid).not.toBe(firstWorker.pid)

    // The worker admitted the file into the durable user message, which proves
    // it resolved the receipt the Host wrote before worker A exited.
    expect(await waitForUserFile(follow, receipt.file.attachmentId)).toBe(true)
    await rpc('session/cancel', { request: { sessionId } })
  }, 600_000)

  it('keeps the browser stream across idle exits and resumes with correct state', async () => {
    // The approval case leaves its own worker until the idle timer reclaims it.
    await waitForNoChildren(host.pid as number, UI_TIMEOUT_MS)
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

function rpc(endpoint: string, args: Record<string, unknown>): Promise<ServerResponseEnvelope['result']> {
  return requestRpc(origin, cookie, endpoint, args)
}

async function collectTurn(reader: StreamReader): Promise<{ readonly assistant: string; readonly tools: string }> {
  const assistant: string[] = []
  const tools: string[] = []
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const frame = await reader.next(deadline - Date.now()) as FollowFrame
    if (frame.type !== 'event') continue
    if (frame.event.type === 'assistant/message') assistant.push(JSON.stringify(frame.event.data))
    if (frame.event.type === 'tool/result') tools.push(JSON.stringify(frame.event.data))
    if (frame.event.type === 'turn/end') {
      return { assistant: assistant.join('\n'), tools: tools.join('\n') }
    }
  }
  throw new Error('turn did not finish before the deadline')
}

async function waitForUserFile(reader: StreamReader, attachmentId: string): Promise<boolean> {
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const frame = await reader.next(deadline - Date.now()) as FollowFrame
    if (frame.type !== 'event' || frame.event.type !== 'user/message') continue
    if (JSON.stringify(frame.event.data).includes(attachmentId)) return true
  }
  return false
}

interface WaterfallFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Record<string, unknown>
}

async function waitForWaterfall(reader: StreamReader): Promise<WaterfallFrame> {
  const deadline = Date.now() + UI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const frame = await reader.next(deadline - Date.now()) as { readonly type: string }
    if (frame.type === 'waterfall') return frame as WaterfallFrame
  }
  throw new Error('no worker waterfall reached the browser before the deadline')
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

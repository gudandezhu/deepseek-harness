/**
 * End-to-end proof of the stage-one memory model: a real `dsh` worker process
 * runs one turn, flushes, exits, and a fresh worker resumes the same Session
 * without a write-lease conflict. The test also samples worker RSS and proves
 * the process is gone after the idle reclaim.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import {
  SessionWorkerSupervisor,
  type SessionWorkerStream,
} from '../src/index.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cliEntry = join(repositoryRoot, 'apps/cli/src/bin.ts')
const builtCliEntry = join(repositoryRoot, 'apps/cli/lib/bin.js')
const electronExecutable = process.env.DSH_TEST_ELECTRON
const workerCommand = electronExecutable === undefined || electronExecutable === ''
  ? [process.execPath, '--import', 'tsx/esm', cliEntry]
  : [electronExecutable, '--expose-internals', builtCliEntry]
const workerEnvironment = electronExecutable === undefined || electronExecutable === ''
  ? {}
  : { ELECTRON_RUN_AS_NODE: '1' }
const MOCK_TEXT = 'mock reply from the session worker'

interface FollowSnapshot {
  readonly type: 'snapshot'
  readonly records: readonly { readonly type: 'event'; readonly event: { readonly type: string; readonly data: unknown } }[]
}

interface FollowEvent {
  readonly type: 'event'
  readonly event: { readonly type: string; readonly data: unknown }
}

let context: Context
let supervisor: SessionWorkerSupervisor
let server: MockLlmServer
let home: string
let project: string

beforeAll(async () => {
  server = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: MOCK_TEXT,
  })
  home = await mkdtemp(join(tmpdir(), 'dsh-session-worker-home-'))
  project = await mkdtemp(join(tmpdir(), 'dsh-session-worker-project-'))
  const patch = join(home, 'session-worker.patch.yml')
  await writeFile(patch, [
    '# Keep the stage-one handoff assertion able to read durable bytes.',
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
  ].join('\n'))

  context = new Context()
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(SessionWorkerSupervisor, {
    command: workerCommand,
    profile: 'session-worker',
    cwd: repositoryRoot,
    args: ['--patch', patch],
    env: {
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      DSH_TELEMETRY_DISABLED: '1',
      ...workerEnvironment,
    },
    idleTimeoutMs: 1_500,
    readyTimeoutMs: 120_000,
    shutdownTimeoutMs: 15_000,
    graceMs: 10_000,
    streamBufferItems: 4_096,
  })
  supervisor = context.sessionWorkers
}, 120_000)

afterAll(async () => {
  await context?.fiber.dispose()
  await server?.close()
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('session worker idle reclaim', () => {
  it('runs a turn, exits on idle, flushes, and resumes in a fresh worker', async () => {
    const sessionId = `session-${randomUUID()}` as SessionId
    const first = await supervisor.acquire(sessionId)
    expect(first.pid).toBeGreaterThan(0)

    const created = await first.call('session/create', { request: { sessionId, cwd: project } })
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, value: { sessionId } })

    const follow = first.open('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 },
    })
    const snapshot = await nextFrame(follow) as FollowSnapshot
    expect(snapshot.type).toBe('snapshot')

    const prompt = await first.call('session/prompt', {
      request: {
        requestId: `request-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'hello worker' }],
      },
    })
    expect(prompt).toMatchObject({ ok: true, value: { accepted: true } })

    const completed = await collectUntilTurnEnd(follow)
    await follow.cancel()
    expect(completed.assistantText).toContain(MOCK_TEXT)

    expect(await first.waitForIdle(60_000)).toBe(true)
    const rss = rssKb(first.pid)
    console.info(`[session-worker] idle pid=${String(first.pid)} rss=${String(rss)}KB`)
    expect(rss).toBeGreaterThan(0)

    await withTimeout(first.exited, 60_000, 'first worker exit')
    expect(isAlive(first.pid)).toBe(false)

    const sessionFile = await findSessionLog(home)
    const durable = await readFile(sessionFile, 'utf8')
    expect(durable).toContain(MOCK_TEXT)

    const second = await supervisor.acquire(sessionId)
    expect(second.pid).not.toBe(first.pid)

    const replay = second.open('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 },
    })
    const replaySnapshot = await nextFrame(replay) as FollowSnapshot
    expect(JSON.stringify(replaySnapshot.records)).toContain(MOCK_TEXT)
    await replay.cancel()

    const resumed = await second.call('session/prompt', {
      request: {
        requestId: `request-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'second turn' }],
      },
    })
    expect(resumed).toMatchObject({ ok: true, value: { accepted: true } })

    const secondFollow = second.open('session/follow', {
      request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 },
    })
    await nextFrame(secondFollow)
    const secondTurn = await collectUntilTurnEnd(secondFollow)
    await secondFollow.cancel()
    expect(secondTurn.assistantText).toContain(MOCK_TEXT)

    expect(await second.waitForIdle(60_000)).toBe(true)
    await second.shutdown()
    expect(isAlive(second.pid)).toBe(false)
    expect(supervisor.get(sessionId)).toBeUndefined()
  }, 300_000)
})

async function nextFrame(stream: SessionWorkerStream): Promise<unknown> {
  const outcome = await withTimeout(stream.next(), 120_000, 'next worker stream frame')
  if (outcome.done === true) throw new Error('stream ended before its expected frame')
  return outcome.value
}

async function collectUntilTurnEnd(
  stream: SessionWorkerStream,
): Promise<{ readonly assistantText: string }> {
  let assistantText = ''
  const assistantParts: string[] = []
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const frame = await nextFrame(stream) as FollowEvent | { readonly type: string }
    if (frame.type !== 'event') continue
    const event = (frame as FollowEvent).event
    if (event.type === 'assistant/message') assistantParts.push(JSON.stringify(event.data))
    if (event.type === 'turn/end') {
      assistantText = assistantParts.join('\n')
      return { assistantText }
    }
  }
  throw new Error('turn did not finish before the test deadline')
}

async function findSessionLog(root: string): Promise<string> {
  const directory = join(root, 'sessions')
  for (const path of await walk(directory)) {
    if (path.endsWith('.jsonl')) return path
  }
  throw new Error(`no Session JSONL was written under ${directory}`)
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

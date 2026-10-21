/**
 * Model-visible parity between the single-process Web composition and the
 * same profile delegating Agent work to a session worker.
 *
 * Both runs use one mock model server, the same checkout, cwd, prompt, and
 * default preset. The comparison reads the request the model actually
 * received: system text, tool schemas, and the admitted user message. The
 * single-process baseline disables the `session-worker-host` row so the Host
 * runs the Agent itself.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import {
  announcedUrl,
  authenticate,
  delay,
  MuxClient,
  requestRpc,
  StreamReader,
} from './support/browser-client.ts'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const cliEntry = join(repositoryRoot, 'apps/cli/src/bin.ts')
const PROMPT = 'Describe the tools you have.'
const MOCK_TEXT = 'mock parity reply'
const UI_TIMEOUT_MS = Number(process.env.DSH_PARITY_TIMEOUT_MS ?? 120_000)
const AUXILIARY_TIMEOUT_MS = 10_000
const LOOPBACK_URL = /(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g

interface ModelRequest {
  readonly model?: string
  readonly system?: unknown
  readonly tools?: readonly { readonly name: string }[]
  readonly messages?: unknown
}

/** One model request in comparable form. */
interface NormalizedRequest {
  readonly model: string | undefined
  readonly system: unknown
  readonly tools: readonly { readonly name: string }[]
  readonly messages: unknown
}

interface RunResult {
  /** The conversation request, identified by its tool catalog. */
  readonly main: NormalizedRequest
  /** Auxiliary requests the Session issues on its own, such as title generation. */
  readonly auxiliary: readonly NormalizedRequest[]
  /** The title event the browser receives from this Session. */
  readonly title: unknown
}

let server: MockLlmServer
const homes: string[] = []

beforeAll(async () => {
  server = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: MOCK_TEXT,
  })
}, UI_TIMEOUT_MS)

afterAll(async () => {
  await server?.close()
  const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const
  for (const home of homes) await rm(home, retry)
})

describe('agent plane parity', () => {
  it.each(['standard', 'ptc', 'minimal', 'cordis'])(
    'sends the single-process and worker %s compositions the same model request',
    async (agentPreset) => {
      const project = await mkdtemp(join(tmpdir(), 'dsh-agent-plane-parity-project-'))
      try {
        const single = await runHost({ project, disableWorker: true, agentPreset })
        const worker = await runHost({ project, disableWorker: false, agentPreset })
        expect(worker.main).toEqual(single.main)
        expect(worker.auxiliary).toEqual(single.auxiliary)
        expect(worker.auxiliary).toHaveLength(1)
        expect(worker.main.tools.length).toBeGreaterThan(0)
        expect(worker.main.messages).toBeDefined()
        expect(worker.title).toEqual(single.title)
      } finally {
        const retry = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const
        await rm(project, retry)
      }
    },
    300_000,
  )
})

/**
 * Boot one Web host, run a single turn, and return the main model request.
 * @param options - shared project cwd, Agent preset, and whether to disable the worker host.
 * @returns the request body the mock model received.
 */
async function runHost(options: {
  readonly project: string
  readonly agentPreset: string
  readonly disableWorker: boolean
}): Promise<RunResult> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-plane-parity-home-'))
  homes.push(home)
  const patches: string[] = []
  if (options.disableWorker) {
    const patch = join(home, 'single-process.patch.yml')
    await writeFile(patch, ['- id: session-worker-host', '  disabled: true', ''].join('\n'))
    patches.push('--patch', patch)
  }
  const startIndex = server.requests.length
  const host = spawn(process.execPath, [
    '--import', 'tsx/esm', cliEntry, '--profile', 'web', ...patches, '--no-open', '--port', '0',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      DSH_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let mux: MuxClient | undefined
  try {
    const url = await announcedUrl(host, UI_TIMEOUT_MS)
    const origin = new URL(url).origin
    const cookie = await authenticate(url)
    const created = await requestRpc(origin, cookie, 'session/create', {
      request: { cwd: options.project, agentPreset: options.agentPreset },
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const sessionId = (created as { ok: true; value: { sessionId: string } }).value.sessionId

    mux = await MuxClient.connect(origin, cookie)
    const follow = mux.open('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        maxMessages: 200,
      },
    })
    const snapshot = await follow.next(UI_TIMEOUT_MS) as { readonly type: string }
    expect(snapshot.type).toBe('snapshot')

    const prompted = await requestRpc(origin, cookie, 'session/prompt', {
      request: {
        requestId: `request-${sessionId}-parity`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: PROMPT }],
      },
    })
    expect(prompted.ok, JSON.stringify(prompted)).toBe(true)
    const { title } = await waitForTurnEnd(follow, startIndex)
    // Title generation is asynchronous; wait for its auxiliary request so both
    // runs compare the same set.
    const deadline = Date.now() + AUXILIARY_TIMEOUT_MS
    let bodies: ModelRequest[] = []
    while (Date.now() < deadline) {
      bodies = server.requests.slice(startIndex).map(record => record.body as ModelRequest)
      if (bodies.some(body => !Array.isArray(body.tools))) break
      await delay(50)
    }
    const main = bodies.find(body => Array.isArray(body.tools))
    if (main === undefined) throw new Error('the mock model received no tool-bearing request')
    return {
      main: normalizeRequest(main),
      auxiliary: bodies.filter(body => !Array.isArray(body.tools)).map(normalizeRequest),
      title,
    }
  } finally {
    mux?.close()
    await stop(host)
  }
}

/**
 * Read the browser stream until the turn ends and the Session title arrives.
 * @param reader - followed Session stream.
 * @param requestStart - mock request count before this run, for diagnostics.
 * @returns the title event data shown to the browser.
 */
async function waitForTurnEnd(reader: StreamReader, requestStart: number): Promise<{ readonly title: unknown }> {
  const deadline = Date.now() + UI_TIMEOUT_MS
  const seen: string[] = []
  let ended = false
  let title: unknown
  while (Date.now() < deadline) {
    const frame = await reader.next(deadline - Date.now()) as {
      readonly type: string
      readonly event?: { readonly type?: string; readonly data?: unknown }
    }
    if (frame.type !== 'event') continue
    seen.push(frame.event?.type ?? '?')
    if (frame.event?.type === 'session/title') title = frame.event.data
    if (frame.event?.type === 'turn/end') ended = true
    if (ended && title !== undefined) return { title }
  }
  if (!ended) {
    throw new Error(
      `the turn did not finish before the deadline; events: ${seen.join(',')};`
      + ` model requests: ${String(server.requests.length - requestStart)}`,
    )
  }
  throw new Error(`the turn ended without a Session title; events: ${seen.join(',')}`)
}

/**
 * Compare the model-visible input, replacing values that differ between two
 * sequential runs: each host's own listener port and the wall clock.
 * @param body - raw request body from the mock server.
 * @returns the same request with those values replaced.
 */
function normalizeRequest(body: ModelRequest): NormalizedRequest {
  return {
    model: typeof body.model === 'string' ? body.model : undefined,
    system: normalizeValue(body.system),
    tools: [...(body.tools ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
    messages: normalizeValue(body.messages),
  }
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll(LOOPBACK_URL, 'http://loopback')
      .replaceAll(ISO_TIMESTAMP, 'timestamp')
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)]))
  }
  return value
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  child.kill('SIGTERM')
  await exited
}

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Connection, Server as SshServer } from 'ssh2'
import type { MachineProfile, RemoteSession } from '../../../packages/dsh-tauri-remote/src/host/types/index'
import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { Server } from 'ssh2'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clearHostRuntime } from '../../../packages/dsh-tauri-remote/src/host/config/runtime'
import { MachineId } from '../../../packages/dsh-tauri-remote/src/host/types/index'
import { RECOMMENDED_DSH_VERSION } from '../../../packages/dsh-tauri-remote/src/host/utils/version'
import { bootHarness, waitFor } from '../support/ssh'

/** One freshly generated RSA key in PKCS#1 PEM form (what ssh2 parses natively). */
function freshRsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return String(privateKey.export({ format: 'pem', type: 'pkcs1' }))
}

afterEach(() => {
  clearHostRuntime()
})

/** Brand a machine id. */
function id(name: string): ReturnType<typeof MachineId> {
  return MachineId(name)
}

/**
 * E2E #2 — backoff rhythm and the give-up terminal state, driven by a
 * persistently unreachable local port (nothing listens on 127.0.0.1:1).
 * Records every event timestamp so the exponential schedule is readable in
 * the evidence log.
 */
describe('e2e give-up (local unreachable port)', () => {
  const profile: MachineProfile = {
    id: id('unreachable'),
    name: 'unreachable',
    host: '127.0.0.1',
    port: 1,
    user: 'root',
    remotePort: 3080,
  }

  it('retries on an exponential schedule, then lands in given-up', async () => {
    const harness = bootHarness({
      connectTimeoutMs: 2_000,
      reconnectInitialDelayMs: 300,
      reconnectMaxDelayMs: 1_200,
      reconnectMaxAttempts: 4,
    })
    const { manager } = harness
    try {
      manager.refreshProfiles(new Map([[profile.id, profile]]))

      // The first failure rejects the caller's connect; the loop continues.
      await expect(manager.connect(profile.id)).rejects.toThrow()
      await waitFor(() => manager.status(profile.id).state === 'given-up', 'give-up', 30_000)

      const status = manager.status(profile.id)
      expect(status.state).toBe('given-up')
      expect(status.nextRetryAt).toBeUndefined()
      expect(status.lastError).toMatch(/connect failed after 5 attempt\(s\)/u)
      expect(status.lastError).toMatch(/host unreachable/u)

      // The retry schedule from the event log: one auth failure per attempt,
      // one reconnect line per scheduled retry, gaps growing 300→600→1200→1200.
      harness.drain()
      const retryLines = harness.evidence.filter(line => line.text.includes('event reconnect: retrying'))
      const gaps: number[] = []
      let previous: number | undefined
      for (const line of retryLines) {
        if (previous !== undefined)
          gaps.push(line.at - previous)
        previous = line.at
      }
      harness.log(`retry gaps: ${gaps.join(', ')} ms`)
      expect(gaps.length).toBeGreaterThanOrEqual(3)
      for (const gap of gaps)
        expect(gap).toBeGreaterThan(0)
      // Each gap at least as long as the previous one (the schedule only
      // grows, capped at 1.2 s; small scheduling jitter tolerated).
      for (let i = 1; i < gaps.length; i++)
        expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 50)

      // A manual disconnect after give-up is a different, clean terminal.
      await manager.disconnect(profile.id)
      expect(manager.status(profile.id).state).toBe('disconnected')
    }
    finally {
      await harness.dispose()
    }
  }, 120_000)
})

/**
 * E2E #3 — password authentication over a real SSH protocol round trip.
 *
 * Environment note: no OS sshd with password login is reachable from this
 * host (local port 22 closed, no docker, and the shared root dev machine's
 * sshd config must not be touched). The stand-in is a loopback ssh2 protocol
 * server that rejects every publickey attempt and accepts exactly one
 * password — the full agent→key→password chain, the order evidence
 * (server-recorded method sequence), and the three failure classes are all
 * exercised over the wire by the real transport.
 *
 * Downgrade label: OS-sshd password E2E 未验证（环境不可得）；本套为本地
 * ssh2 协议服务器替代证据。
 */
describe('e2e password chain (loopback ssh2 protocol server)', () => {
  const PASSWORD = 'e2e-trustno1'

  /** One server-side authentication attempt record. */
  interface AuthAttempt {
    method: string
    accepted: boolean
  }

  /** The recorded auth attempts and the accepted method, per connection. */
  const attempts: AuthAttempt[] = []
  let server: SshServer
  let serverPort = 0
  let scratchHome: string
  let scratchSshDir: string
  const envBefore: { USERPROFILE: string | undefined, HOME: string | undefined } = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  }

  /**
   * A scratch identity file is fed to the host as `~/.ssh/id_rsa` of a scratch
   * HOME, not as an absolute path: `resolveSshAuth` treats every identity path
   * that does not literally start with `/` as home-relative
   * (`host/utils/ssh-config.ts:37-41`), so a Windows drive path such as
   * `C:/…/.ssh/id_rsa` is joined onto the home dir twice and resolves to no
   * key at all. Going through the home-relative branch keeps the production
   * path (config discovery → identity files → transport auth order) real on
   * every platform; the absolute-path defect is the package's own problem
   * (`utils/ssh-config.test.ts` is red on Windows for exactly that reason).
   */
  beforeAll(async () => {
    // A fresh host key pair for the server and one for the client's (rejected)
    // identity file.
    const hostKey = freshRsaPem()
    const clientKey = freshRsaPem()
    scratchHome = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-home-'))
    scratchSshDir = join(scratchHome, '.ssh')
    mkdirSync(scratchSshDir, { recursive: true })
    writeFileSync(join(scratchSshDir, 'id_rsa'), clientKey)
    // `homeDir()` is read when the runtime is assembled, so it must already
    // point at the scratch home before the first `bootHarness` in each `it`.
    process.env.USERPROFILE = scratchHome
    process.env.HOME = scratchHome

    server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD) {
          attempts.push({ method: ctx.method, accepted: true })
          ctx.accept()
          return
        }
        attempts.push({ method: ctx.method, accepted: false })
        ctx.reject(['publickey', 'password'])
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec) => {
          const stream = acceptExec()
          stream.write('Linux x86_64\n')
          stream.exit(0)
          stream.end()
        })
      })
      client.on('error', () => {
        // Client-side hangups during failure cases surface here; expected.
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    serverPort = (server.address() as { port: number }).port
  })

  afterAll(() => {
    server.close()
    rmSync(scratchHome, { recursive: true, force: true })
    if (envBefore.USERPROFILE === undefined)
      delete process.env.USERPROFILE
    else process.env.USERPROFILE = envBefore.USERPROFILE
    if (envBefore.HOME === undefined)
      delete process.env.HOME
    else process.env.HOME = envBefore.HOME
  })

  function profileWith(password?: string): MachineProfile {
    return {
      id: id('password-e2e'),
      name: 'password-e2e',
      host: '127.0.0.1',
      port: serverPort,
      user: 'root',
      ...password === undefined ? {} : { password },
      remotePort: 3080,
    }
  }

  it('authenticates with the stored password after agent and keys are refused', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith(PASSWORD)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result).toEqual({ ok: true, banner: 'Linux x86_64' })

      // Order evidence: every publickey attempt (agent-sourced and the
      // identity file) precedes the accepted password attempt.
      const methods = attempts.map(attempt => attempt.method)
      harness.log(`server saw auth methods: ${methods.join(' -> ')}`)
      expect(methods[methods.length - 1]).toBe('password')
      expect(attempts.at(-1)?.accepted).toBe(true)
      const passwordIndex = methods.indexOf('password')
      expect(methods.slice(0, passwordIndex).every(method => method === 'publickey')).toBe(true)
      expect(passwordIndex).toBeGreaterThan(0)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies a wrong stored password as password-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith('wrong-password')
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/stored password was rejected/u)
    }
    finally {
      await harness.dispose()
    }
  })

  it('classifies exhausted keys without a password as key-rejected', async () => {
    attempts.length = 0
    const harness = bootHarness({ sshDir: '.ssh', connectTimeoutMs: 5_000 })
    try {
      const profile = profileWith()
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const result = await harness.manager.test(profile.id)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/no key or ssh-agent was accepted/u)
    }
    finally {
      await harness.dispose()
    }
  })
})

/**
 * E2E #4 — the keepalive watchdog on a hung (silent) connection. A local
 * proxy stops forwarding bytes in both directions (no FIN, no RST — exactly
 * what a NAT/firewall drop looks like); ssh2's keepalive misses its
 * heartbeat budget and must declare the session closed, surfacing through
 * the session's onClosed callback (the manager's reconnect trigger).
 *
 * The session comes from `machine.openSession`, i.e. the keepalive budget is
 * the assembled Config's, not a hand-built transport's.
 */
describe('e2e keepalive watchdog (silent connection freeze)', () => {
  const PASSWORD = 'e2e-watchdog'
  const KEEPALIVE_INTERVAL_MS = 1_000
  const KEEPALIVE_COUNT_MAX = 3

  let server: SshServer
  let serverPort = 0
  let scratchSshDir: string

  /** The stalling proxy: pipes traffic until `freeze()` silently drops it. */
  function startStallingProxy(): Promise<{ port: number, freeze: () => void, close: () => void }> {
    const sockets = new Set<{ a: import('node:net').Socket, b: import('node:net').Socket }>()
    const proxy = createServer((downstream) => {
      const upstream = tcpConnect(serverPort, '127.0.0.1')
      const pair = { a: downstream, b: upstream }
      sockets.add(pair)
      downstream.on('close', () => sockets.delete(pair))
      upstream.on('close', () => sockets.delete(pair))
      downstream.pipe(upstream)
      upstream.pipe(downstream)
      downstream.on('error', () => downstream.destroy())
      upstream.on('error', () => upstream.destroy())
    })
    return new Promise((resolve) => {
      proxy.listen(0, '127.0.0.1', () => {
        resolve({
          port: (proxy.address() as { port: number }).port,
          freeze: (): void => {
            // Stop forwarding in both directions without closing anything: the
            // client sees a silent, still-open TCP connection.
            for (const { a, b } of sockets) {
              a.unpipe(b)
              b.unpipe(a)
              a.pause()
              b.pause()
            }
          },
          close: (): void => {
            for (const { a, b } of sockets) {
              a.destroy()
              b.destroy()
            }
            proxy.close()
          },
        })
      })
    })
  }

  beforeAll(async () => {
    server = new Server({ hostKeys: [freshRsaPem()] }, (client: Connection) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD)
          ctx.accept()
        else
          ctx.reject(['password'])
      })
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec) => {
          const stream = acceptExec()
          stream.write('Linux x86_64\n')
          stream.exit(0)
          stream.end()
        })
      })
      client.on('error', () => {
        // Watchdog teardowns land here on the server side; expected.
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    serverPort = (server.address() as { port: number }).port
    scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-watchdog-'))
    writeFileSync(join(scratchSshDir, 'config'), '')
  })

  afterAll(() => {
    server.close()
    rmSync(scratchSshDir, { recursive: true, force: true })
  })

  it('declares a hung session closed after the heartbeat budget', async () => {
    const proxy = await startStallingProxy()
    const profile: MachineProfile = {
      id: MachineId('watchdog'),
      name: 'watchdog',
      host: '127.0.0.1',
      port: proxy.port,
      user: 'root',
      password: PASSWORD,
      remotePort: 3080,
    }
    const harness = bootHarness({
      connectTimeoutMs: 5_000,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      sshDir: scratchSshDir,
    })
    let session: RemoteSession | undefined
    try {
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const opened = await harness.manager.openSession(profile.id)
      session = opened
      expect(opened.authMethod).toBe('password')

      const closedAt = new Promise<number>((resolve) => {
        opened.onClosed(() => resolve(Date.now()))
      })
      const frozeAt = Date.now()
      proxy.freeze()

      // ssh2 must give up after ~interval*(countMax) of unanswered
      // heartbeats and surface the close — not hang forever on the silent
      // socket. Assert a generous upper bound so the test stays robust.
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('watchdog never declared the session closed')), 30_000)
      })
      const closed = await Promise.race([closedAt, timeout])
      const elapsed = closed - frozeAt
      // eslint-disable-next-line no-console -- evidence log
      console.log(`[watchdog] silent freeze → close after ${elapsed} ms (interval ${KEEPALIVE_INTERVAL_MS} ms × ${KEEPALIVE_COUNT_MAX} missed)`)
      expect(elapsed).toBeGreaterThan(KEEPALIVE_INTERVAL_MS * KEEPALIVE_COUNT_MAX - 500)
      expect(elapsed).toBeLessThan(20_000)
    }
    finally {
      await session?.close().catch(() => undefined)
      proxy.close()
      await harness.dispose()
    }
  }, 60_000)
})

/**
 * E2E #5 — 出站网关：干净 link、身份改写与 SSH 链路压缩，全部跑在真实 ssh2 协议往返上。
 *
 * 远端 DSH 用本机 HTTP 服务器顶替（`/?token=` 铸造会话 cookie，其余请求按 cookie 放行），
 * SSH 服务端是回环 ssh2 协议服务器：exec 通道回答健康探测与启动 token 读取，direct-tcpip
 * 通道把隧道流量转给那台 HTTP 服务器。客户端与 sshd 之间挂一枚计数代理，把「链路压缩是否
 * 真的生效」量成字节数；压缩协商结果直接读服务端连接的 `_protocol._kex.negotiated`。
 *
 * 环境降级标注：真实远端 DSH 与真实公网隧道不在本环境内（无可用远端机），桌面临窗口内的
 * 真实对话与断网重连属人工验收；本套只覆盖可自动化的出站契约。
 */
describe('e2e outbound gateway (loopback ssh2 protocol server)', () => {
  const PASSWORD = 'e2e-outbound'
  const TOKEN = 'tok-e2e-outbound'
  const BULK_BYTES = 200 * 1024
  const BULK = Buffer.alloc(BULK_BYTES, 0x41)
  const BOOT_HTML = '<html><body><script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/@deepseek-ai/dsh-client-ui-layout/client.js"}]};</script></body></html>'

  interface RemoteRequest {
    url: string
    host: string | undefined
    encoding: string | undefined
    cookie: string | undefined
  }

  interface Upstream {
    port: number
    requests: RemoteRequest[]
    close: () => Promise<void>
  }

  interface SshdState {
    negotiated: string | undefined
    commands: string[]
  }

  interface Sshd {
    server: SshServer
    port: number
    state: SshdState
  }

  let sshd: Sshd
  let plainSshd: Sshd
  let sshdProxy: { port: number, close: () => void }
  let plainProxy: { port: number, close: () => void }
  let wireBytes = 0
  let scratchSshDir = ''

  /** 远端 DSH 的替身：按启动 token 铸造会话 cookie，其余请求必须带对 cookie 才放行。 */
  async function startUpstream(port = 0): Promise<Upstream> {
    const requests: RemoteRequest[] = []
    const upgraded = new Set<Duplex>()
    const server = createHttpServer((request, response) => {
      const url = request.url ?? ''
      requests.push({
        url,
        host: request.headers.host,
        encoding: request.headers['accept-encoding'],
        cookie: request.headers.cookie,
      })
      if (url.startsWith('/?token=')) {
        if (url !== `/?token=${TOKEN}`) {
          response.statusCode = 401
          response.end('bad token')
          return
        }
        response.setHeader('set-cookie', [`dsh-session=${TOKEN}; Path=/; HttpOnly`])
        response.end('minted')
        return
      }
      if (request.headers.cookie !== `dsh-session=${TOKEN}`) {
        response.statusCode = 401
        response.end('unauthorized')
        return
      }
      if (url === '/bulk') {
        response.setHeader('content-type', 'application/javascript')
        response.end(BULK)
        return
      }
      response.setHeader('content-type', 'text/html')
      response.end('dsh-ok')
    })
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve())
    })
    server.on('upgrade', (request, socket) => {
      // 升级后的 socket 已脱离 server 的连接跟踪，必须自己记账才能在收尾时销毁。
      upgraded.add(socket)
      socket.on('close', () => upgraded.delete(socket))
      requests.push({
        url: request.url ?? '',
        host: request.headers.host,
        encoding: request.headers['accept-encoding'],
        cookie: request.headers.cookie,
      })
      acceptWebSocket(request, socket)
    })
    return {
      port: (server.address() as { port: number }).port,
      requests,
      close: async () => {
        for (const socket of upgraded)
          socket.destroy()
        upgraded.clear()
        server.closeAllConnections()
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      },
    }
  }

  /** 远端 DSH 的 WebSocket 端点替身：同样要求会话 cookie，回显每一帧文本/二进制。 */
  function acceptWebSocket(request: IncomingMessage, socket: Duplex): void {
    const key = request.headers['sec-websocket-key']
    if (request.headers.cookie !== `dsh-session=${TOKEN}` || typeof key !== 'string') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    echoFrames(socket)
  }

  /** 最小帧编解码：只认单帧文本/二进制与关闭帧，足以证明升级链路端到端可用。 */
  function echoFrames(socket: Duplex): void {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0F
        const masked = (pending[1]! & 0x80) !== 0
        let length = pending[1]! & 0x7F
        let offset = 2
        if (length === 126) {
          if (pending.length < 4)
            return
          length = pending.readUInt16BE(2)
          offset = 4
        }
        const maskLength = masked ? 4 : 0
        if (pending.length < offset + maskLength + length)
          return
        const mask = masked ? pending.subarray(offset, offset + 4) : undefined
        const payload = Buffer.from(pending.subarray(offset + maskLength, offset + maskLength + length))
        if (mask !== undefined) {
          for (let index = 0; index < payload.length; index++)
            payload[index] = payload[index]! ^ mask[index % 4]!
        }
        pending = pending.subarray(offset + maskLength + length)
        if (opcode === 0x8) {
          socket.write(Buffer.from([0x88, 0x00]))
          socket.end()
          return
        }
        if (opcode === 0x1 || opcode === 0x2)
          socket.write(frameOf(opcode, payload))
      }
    })
  }

  function frameOf(opcode: number, payload: Buffer): Buffer {
    if (payload.length < 126)
      return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
    const extended = Buffer.alloc(2)
    extended.writeUInt16BE(payload.length)
    return Buffer.concat([Buffer.from([0x80 | opcode, 126]), extended, payload])
  }

  function echoOnce(socket: WebSocket, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('e2e: WebSocket 回显超时')), 15_000)
      socket.addEventListener('open', () => socket.send(text))
      socket.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(String(event.data))
        socket.close()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('e2e: WebSocket 升级失败'))
      })
    })
  }

  /**
   * 回环 ssh2 协议服务器。`compressAlgorithms` 省略即 ssh2 默认（服务端偏好 `none`，
   * 但按 RFC 4253 由客户端的优先序决定结果）；传 `['none']` 即「服务端不支持延迟压缩」。
   */
  async function startSshd(compressAlgorithms?: ['none']): Promise<Sshd> {
    const state: SshdState = { negotiated: undefined, commands: [] }
    const server = new Server(
      {
        hostKeys: [freshRsaPem()],
        ...compressAlgorithms === undefined ? {} : { algorithms: { compress: compressAlgorithms } },
      },
      (client: Connection) => {
        client.on('authentication', (ctx) => {
          if (ctx.method === 'password' && ctx.password === PASSWORD) {
            ctx.accept()
            return
          }
          ctx.reject(['publickey', 'password'])
        })
        client.on('ready', () => {
          const kex = (client as unknown as {
            _protocol?: { _kex?: { negotiated?: { cs?: { compress?: string } } } }
          })._protocol?._kex
          state.negotiated = kex?.negotiated?.cs?.compress
        })
        client.on('session', (accept) => {
          const session = accept()
          session.on('exec', (acceptExec, _rejectExec, info) => {
            const stream = acceptExec()
            const command = (info as { command?: string }).command ?? ''
            state.commands.push(command)
            if (command.includes('grep -oE') && command.includes('token=')) {
              stream.write(`${TOKEN}\n`)
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('REMOTE_DSH_LISTENER_PACKAGE')) {
              stream.write(JSON.stringify({ name: '@deepseek-ai/dsh', version: RECOMMENDED_DSH_VERSION }))
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('REMOTE_DSH_LISTENER_PID')) {
              stream.write([
                'Linux',
                '4242',
                '/opt/remote-dsh',
                '1760000000:987654',
                '/usr/bin/node\0/opt/remote-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js\0',
              ].join('\n'))
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('%{http_code}')) {
              stream.write('console.log(1)\n200')
              stream.exit(0)
              stream.end()
              return
            }
            if (command.includes('curl -s -m')) {
              stream.write(BOOT_HTML)
              stream.exit(0)
              stream.end()
              return
            }
            stream.stderr.write('e2e: 未实现的远端命令\n')
            stream.exit(1)
            stream.end()
          })
        })
        client.on('tcpip', (accept, _reject, info) => {
          const channel = accept()
          const dest = tcpConnect((info as { destPort: number }).destPort, '127.0.0.1')
          channel.pipe(dest).pipe(channel)
          channel.on('close', () => dest.destroy())
          dest.on('error', () => channel.close())
        })
        client.on('error', () => {
          // 断连与杀上游都由客户端侧发起，服务端只收尾。
        })
      },
    )
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    return { server, port: (server.address() as { port: number }).port, state }
  }

  /** 计数代理：客户端连它，它连 sshd；两个方向的字节都计入 `wireBytes`。 */
  function startProxy(target: number): Promise<{ port: number, close: () => void }> {
    const proxy = createServer((down) => {
      const up = tcpConnect(target, '127.0.0.1')
      down.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length
      })
      up.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length
      })
      down.pipe(up).pipe(down)
      down.on('error', () => down.destroy())
      up.on('error', () => up.destroy())
    })
    return new Promise((resolve) => {
      proxy.listen(0, '127.0.0.1', () => resolve({
        port: (proxy.address() as { port: number }).port,
        close: () => proxy.close(),
      }))
    })
  }

  function profileFor(port: number, remotePort: number): MachineProfile {
    return {
      id: id('outbound-gateway'),
      name: 'outbound-gateway',
      host: '127.0.0.1',
      port,
      user: 'root',
      password: PASSWORD,
      remotePort,
    }
  }

  beforeAll(async () => {
    sshd = await startSshd()
    plainSshd = await startSshd(['none'])
    sshdProxy = await startProxy(sshd.port)
    plainProxy = await startProxy(plainSshd.port)
    scratchSshDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-gateway-'))
    writeFileSync(join(scratchSshDir, 'config'), '')
  })

  afterAll(() => {
    sshd.server.close()
    plainSshd.server.close()
    sshdProxy.close()
    plainProxy.close()
    rmSync(scratchSshDir, { recursive: true, force: true })
  })

  it('publishes a credential-free loopback link and proxies a real request through the gateway', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(link.tunnelBaseUrl, `link 必须是无凭据的回环入口，实际 ${link.tunnelBaseUrl}`).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(link.tunnelBaseUrl).not.toContain('token')
      expect(harness.manager.status(profile.id).state).toBe('connected')
      harness.log(`connected link=${link.tunnelBaseUrl}`)

      const response = await fetch(link.tunnelBaseUrl)
      const gatewayPort = new URL(link.tunnelBaseUrl).port
      harness.log(`remote instance saw ${JSON.stringify(upstream.requests)}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('dsh-ok')
      expect(upstream.requests.map(record => record.url)).toEqual([`/?token=${TOKEN}`, '/'])
      expect(upstream.requests[1]?.cookie).toBe(`dsh-session=${TOKEN}`)
      expect(upstream.requests[1]?.host).toBe(`127.0.0.1:${gatewayPort}`)
      expect(upstream.requests[1]?.encoding).toBe('identity')
      expect(upstream.requests[1]?.url).toBe('/')
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('negotiates zlib@openssh.com and shrinks the tunnel bytes for a compressible body', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      // 协商结果记在服务端连接上且跨用例存活：本用例的断言必须由本用例的连接满足
      sshd.state.negotiated = undefined
      plainSshd.state.negotiated = undefined
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(sshd.state.negotiated).toBe('zlib@openssh.com')
      harness.log(`sshd negotiated compress=${String(sshd.state.negotiated)}`)

      wireBytes = 0
      const response = await fetch(`${link.tunnelBaseUrl}/bulk`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body.length).toBe(BULK_BYTES)
      harness.log(`wire ${wireBytes} bytes for a ${BULK_BYTES}-byte body`)
      expect(wireBytes).toBeLessThan(BULK_BYTES / 5)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('degrades silently to no compression when the server does not offer it', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      plainSshd.state.negotiated = undefined
      const profile = profileFor(plainProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect(plainSshd.state.negotiated).toBe('none')
      harness.log(`sshd negotiated compress=${String(plainSshd.state.negotiated)}`)

      wireBytes = 0
      const response = await fetch(`${link.tunnelBaseUrl}/bulk`)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body.length).toBe(BULK_BYTES)
      harness.log(`wire ${wireBytes} bytes for a ${BULK_BYTES}-byte body without link compression`)
      expect(wireBytes).toBeGreaterThan(BULK_BYTES)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('reuses the gateway port across a disconnect so the link survives a reconnect', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const first = await harness.manager.connect(profile.id)
      await harness.manager.disconnect(profile.id)
      expect(harness.manager.status(profile.id).state).toBe('disconnected')
      const again = await harness.manager.connect(profile.id)
      expect(again.tunnelBaseUrl).toBe(first.tunnelBaseUrl)
      harness.log(`rebound the same gateway port ${again.tunnelBaseUrl}`)
      expect((await fetch(again.tunnelBaseUrl)).status).toBe(200)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)

  it('keeps the link and the SSH session when the remote instance dies, and serves it again once the instance is back', async () => {
    const upstream = await startUpstream()
    const port = upstream.port
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000, reconnectInitialDelayMs: 300, reconnectMaxAttempts: 4 })
    let live = upstream
    try {
      const profile = profileFor(sshdProxy.port, port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      expect((await fetch(link.tunnelBaseUrl)).status).toBe(200)

      // 只杀远端实例：隧道口（SSH 转发监听口）仍在，链路没有断，因此禁止重拨与换 link
      await live.close()
      const response = await fetch(link.tunnelBaseUrl)
      expect(response.status).toBe(502)
      await waitFor(() => (harness.manager.status(profile.id).lastError ?? '').includes('上游不可达'), 'readable per-request failure')
      expect(harness.manager.status(profile.id).state).toBe('connected')
      harness.log(`observed a per-request failure while still connected: ${harness.manager.status(profile.id).lastError}`)

      live = await startUpstream(port)
      const deadline = Date.now() + 30_000
      let resumed = await fetch(link.tunnelBaseUrl)
      while (resumed.status !== 200 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        resumed = await fetch(link.tunnelBaseUrl)
      }
      expect(resumed.status).toBe(200)
      expect(harness.manager.status(profile.id).state).toBe('connected')
      expect(harness.manager.link(profile.id)?.tunnelBaseUrl).toBe(link.tunnelBaseUrl)
      harness.log(`link serves again at the SAME ${link.tunnelBaseUrl} without a reconnect`)
    }
    finally {
      await live.close()
      await harness.dispose()
    }
  }, 120_000)

  it('carries a WebSocket upgrade end to end through the outbound gateway', async () => {
    const upstream = await startUpstream()
    const harness = bootHarness({ sshDir: scratchSshDir, connectTimeoutMs: 5_000 })
    try {
      const profile = profileFor(sshdProxy.port, upstream.port)
      harness.manager.refreshProfiles(new Map([[profile.id, profile]]))
      const link = await harness.manager.connect(profile.id)
      const gatewayPort = new URL(link.tunnelBaseUrl).port

      // 全部 RPC 与对话流都跑在这条 WebSocket 上：升级链路必须端到端可用
      const echoUrl = `${link.tunnelBaseUrl.replace(/^http/u, 'ws')}/api/remote.mux`
      const echoed = await echoOnce(new WebSocket(echoUrl), 'ping-through-tunnel')
      expect(echoed).toBe('ping-through-tunnel')

      const upgrade = upstream.requests.find(record => record.url === '/api/remote.mux')
      expect(upgrade, '远端替身必须收到升级请求').toBeDefined()
      expect(upgrade?.cookie, '升级请求同样由网关注入铸造出的会话 cookie').toBe(`dsh-session=${TOKEN}`)
      expect(upgrade?.host).toBe(`127.0.0.1:${gatewayPort}`)
      harness.log(`upgraded through ${link.tunnelBaseUrl} and echoed a frame`)
    }
    finally {
      await harness.dispose()
      await upstream.close()
    }
  }, 90_000)
})

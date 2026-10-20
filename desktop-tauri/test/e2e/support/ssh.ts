import type { MachineId, RemoteHostContext } from '../../../packages/dsh-tauri-remote/src/host/types/index'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { join } from 'pathe'
import { clearHostRuntime, machineProfiles, setCurrentHostInstance, setHostConfig, setMachineDeps } from '../../../packages/dsh-tauri-remote/src/host/config/runtime'
import { events } from '../../../packages/dsh-tauri-remote/src/host/service/events'
import { machine } from '../../../packages/dsh-tauri-remote/src/host/service/machine'
import { sshTransport } from '../../../packages/dsh-tauri-remote/src/host/service/transport.ssh'
import { EMPTY_ALLOWLIST } from '../../../packages/dsh-tauri-remote/src/host/utils/allowlist'

interface EvidenceLine {
  at: number
  text: string
}

interface Harness {
  manager: typeof machine
  evidence: EvidenceLine[]
  drain: () => void
  log: (text: string) => void
  dispose: () => Promise<void>
}

export function bootHarness(options: {
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  reconnectMaxAttempts?: number
  healthPollIntervalMs?: number
  healthPollAttempts?: number
  sshDir?: string
} = {}): Harness {
  const evidence: EvidenceLine[] = []
  const t0 = Date.now()
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-e2e-'))
  const seenSeq = new Map<MachineId, number>()
  const drain = (): void => {
    for (const machineId of machineProfiles.keys()) {
      const page = events.since(machineId, seenSeq.get(machineId) ?? 0)
      const last = page.events.at(-1)?.seq
      if (last !== undefined)
        seenSeq.set(machineId, last)
      for (const event of page.events) {
        const at = Date.parse(event.ts)
        evidence.push({
          at: Number.isNaN(at) ? Date.now() : at,
          text: `event ${event.stage}${event.terminal === undefined ? '' : `/${event.terminal}`}: ${event.line}`,
        })
      }
    }
  }
  const log = (text: string): void => {
    drain()
    const line = { at: Date.now(), text }
    evidence.push(line)
    process.stderr.write(`[ssh-e2e +${line.at - t0}ms] ${text}\n`)
  }
  const context: RemoteHostContext = {
    webServer: { register: () => () => {} },
    effect: () => undefined,
  }
  clearHostRuntime()
  setCurrentHostInstance(context)
  setHostConfig({
    connectTimeoutMs: options.connectTimeoutMs ?? 15_000,
    healthCheckTimeoutMs: 3_000,
    healthPollIntervalMs: options.healthPollIntervalMs ?? 500,
    healthPollAttempts: options.healthPollAttempts ?? 30,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 3_000,
    keepaliveCountMax: options.keepaliveCountMax ?? 3,
    reconnectInitialDelayMs: options.reconnectInitialDelayMs ?? 1_000,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs ?? 5_000,
    reconnectMaxAttempts: options.reconnectMaxAttempts ?? 6,
    sshDir: options.sshDir ?? join(root, 'ssh'),
    knownHostsPath: join(root, 'known-hosts.json'),
    statePath: join(root, 'machines.json'),
  })
  setMachineDeps({
    transport: { resolve: () => sshTransport },
    emitStatus: (statusId, status) => {
      const hints = [
        status.state,
        ...status.tunnelBaseUrl === undefined ? [] : [`tunnel=${status.tunnelBaseUrl}`],
        ...status.nextRetryAt === undefined ? [] : [`nextRetryAt=+${status.nextRetryAt - Date.now()}ms`],
        ...status.authMethod === undefined ? [] : [`auth=${status.authMethod}`],
        ...status.lastError === undefined ? [] : [`lastError=${status.lastError}`],
      ]
      log(`status ${String(statusId)}: ${hints.join(' ')}`)
    },
    localAllowlist: () => ({ ...EMPTY_ALLOWLIST }),
  })
  const poller = setInterval(drain, 50)
  return {
    manager: machine,
    evidence,
    drain,
    log,
    dispose: async () => {
      clearInterval(poller)
      drain()
      try {
        await machine.dispose()
      }
      finally {
        clearHostRuntime()
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

export async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

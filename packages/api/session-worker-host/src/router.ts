/**
 * Route Session write endpoints to the worker that owns their Agent.
 *
 * The table is deliberately narrow: host-owned cold reads and live
 * presentation stay in this process, while anything that mutates an Agent's
 * Session crosses the process boundary. A worker is spawned only when the
 * endpoint is a real request for work, never because a browser opened a
 * Session.
 *
 * @module @deepseek-ai/dsh-session-worker-host/router
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionWorkerLives } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionWorkerHandle, SessionWorkerSupervisor } from '@deepseek-ai/dsh-session-worker-supervisor'
import type { TypertEndpointRouter } from '@deepseek-ai/dsh-api-gateway'

/** One forwarded write endpoint and how to find or mint its Session. */
interface RoutedWrite {
  /** Read the addressed Session; `mint` runs when none is present. */
  readonly session: (args: Readonly<Record<string, unknown>>) => RouteTarget | undefined
  /** Spawn a worker when none is live; false keeps cold calls on the Host path. */
  readonly spawn: boolean
  /** Attach live state only after the call succeeds (the Session may not exist yet). */
  readonly attachAfter?: boolean
}

/** One resolved routing decision. */
interface RouteTarget {
  readonly sessionId: SessionId
  /** Arguments forwarded to the worker, possibly carrying a minted identity. */
  readonly args: Readonly<Record<string, unknown>>
}

const SESSION_WRITES: Readonly<Record<string, RoutedWrite>> = {
  'session/prompt': sessionField('sessionId'),
  'session/cancel': { ...sessionField('sessionId'), spawn: false },
  'session/rename': sessionField('sessionId'),
  'session/selectModel': sessionField('sessionId'),
  'session/updateQueue': sessionField('sessionId'),
  'session/create': {
    session: (args) => {
      const requested = readId(args, 'sessionId')
      if (requested !== undefined) return { sessionId: requested, args }
      const sessionId = `session-${randomUUID()}` as SessionId
      return { sessionId, args: { ...args, sessionId } }
    },
    spawn: true,
    attachAfter: true,
  },
  'commands/execute': sessionField('agentId'),
  'subagents/prompt': sessionField('parentSessionId'),
  'subagent/interruptByParent': { ...sessionField('parentSessionId'), spawn: false },
  'job/kill': { ...sessionField('sessionId'), spawn: false },
}

/**
 * Host endpoint router for one `sessionWorkerRouter` registration.
 *
 * A routed call never resolves a Typert descriptor or a local Agent; the
 * worker performs both in its own process.
 */
export class SessionWorkerRouter implements TypertEndpointRouter {
  /**
   * @param ctx - host context carrying remote access and logging.
   * @param supervisor - worker process owner.
   * @param lives - live Session cache browser streams read from.
   */
  constructor(
    private readonly ctx: Context,
    private readonly supervisor: SessionWorkerSupervisor,
    private readonly lives: SessionWorkerLives | undefined,
  ) {}

  /** @inheritdoc */
  claims(endpoint: string): boolean {
    return SESSION_WRITES[endpoint] !== undefined
  }

  /** @inheritdoc */
  dispatch(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: PeerScope,
  ): Promise<ConnectionRpcResult<unknown>> | undefined {
    const route = SESSION_WRITES[endpoint]
    if (route === undefined) return undefined
    const args = argsOf(payload)
    if (args === undefined) return undefined
    const target = route.session(args)
    if (target === undefined) return undefined
    const denied = this.denied(endpoint, target.sessionId, args, peer)
    if (denied !== undefined) return Promise.resolve(denied)
    const live = this.supervisor.get(target.sessionId)
    // A cold cancel or job control call has no worker-owned state; the host
    // path owns the canonical "not attached" and "unknown job" failures.
    if (live === undefined && !route.spawn) return undefined
    return this.forward(endpoint, route, target, live, signal)
  }

  private async forward(
    endpoint: string,
    route: RoutedWrite,
    target: RouteTarget,
    live: SessionWorkerHandle | undefined,
    signal: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>> {
    let worker = live
    if (worker === undefined) {
      try {
        worker = await this.supervisor.acquire(target.sessionId)
      } catch (error) {
        return workerFailure(
          'session-worker/unavailable',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (route.attachAfter !== true) this.lives?.attach(target.sessionId, worker)
    const result = await worker.call(endpoint, target.args, { signal })
    if (route.attachAfter === true && result.ok) this.lives?.attach(target.sessionId, worker)
    return result
  }

  private denied(
    endpoint: string,
    sessionId: SessionId,
    args: Readonly<Record<string, unknown>>,
    peer: PeerScope,
  ): ConnectionRpcResult<never> | undefined {
    // The owner short-circuits inside `decide`, so this only consults policies
    // for non-owner callers.
    const decision = this.ctx.remoteAccess.decide({
      principal: peer.principal,
      action: endpoint as RemoteAccessAction,
      resources: [{ kind: 'session', id: sessionId }],
      args,
    })
    if (decision.kind !== 'deny') return undefined
    return {
      ok: false,
      error: {
        code: 'remote-access/denied',
        message: `remote access: ${endpoint}: access denied (${decision.reason})`,
        details: { action: endpoint, reason: decision.reason },
      },
    }
  }
}

function sessionField(field: string): RoutedWrite {
  return {
    session: (args) => {
      const sessionId = readId(args, field)
      return sessionId === undefined ? undefined : { sessionId, args }
    },
    spawn: true,
  }
}

function argsOf(payload: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const args = (payload as Record<string, unknown>)['args']
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : undefined
}

function readId(args: Readonly<Record<string, unknown>>, field: string): SessionId | undefined {
  const value = args[field]
  return typeof value === 'string' && value.length > 0 ? value as SessionId : undefined
}

function workerFailure(code: string, message: string): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

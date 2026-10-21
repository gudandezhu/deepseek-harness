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
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId, type Workspace, type WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  resolveSessionWorkspaceFor,
  type SessionDeliverValue,
  type SessionReminderDelivery,
  type SessionWorkerLives,
} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionWorkerHandle, SessionWorkerSupervisor } from '@deepseek-ai/dsh-session-worker-supervisor'
import type { TypertEndpointRouter } from '@deepseek-ai/dsh-api-gateway'
import type { SessionWorkerEvents } from './events.ts'

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

/** Internal deliveries have no caller cancellation to forward. */
const NO_CANCELLATION = new AbortController().signal

const SESSION_WRITES: Readonly<Record<string, RoutedWrite>> = {
  'session/prompt': requestField('sessionId'),
  // Schedule delivery must reach the worker that owns the Agent; serving it in
  // the Host would resume a second Agent and contend for the write lease.
  'session/deliverReminder': requestField('sessionId'),
  'session/cancel': { ...requestField('sessionId'), spawn: false },
  'session/rename': requestField('sessionId'),
  'session/selectModel': requestField('sessionId'),
  'session/updateQueue': requestField('sessionId'),
  // A fork reads the source log and writes the child in the owning worker, so
  // the child is durable before the browser sees its identity.
  'session/fork': requestField('sessionId'),
  'session/create': {
    session: (args) => {
      const request = requestOf(args)
      if (request === undefined) return undefined
      const requested = readId(request, 'sessionId')
      if (requested !== undefined) return { sessionId: requested, args }
      const sessionId = `session-${randomUUID()}` as SessionId
      return { sessionId, args: { ...args, request: { ...request, sessionId } } }
    },
    spawn: true,
    attachAfter: true,
  },
  'commands/execute': topLevelField('agentId'),
  'subagents/prompt': requestField('parentSessionId'),
  'subagent/interruptByParent': { ...topLevelField('parentSessionId'), spawn: false },
  'job/kill': { ...requestField('sessionId'), spawn: false },
}

/**
 * Passive stream endpoints served by the worker that owns the Session; a cold
 * Session falls through to the Host's own empty registry.
 */
const SESSION_STREAMS: Readonly<Record<string, (args: Readonly<Record<string, unknown>>) => SessionId | undefined>> = {
  'job/list': (args) => {
    const request = requestOf(args)
    return request === undefined ? undefined : readId(request, 'sessionId')
  },
  'job/follow': (args) => {
    const request = requestOf(args)
    return request === undefined ? undefined : readId(request, 'sessionId')
  },
}

/**
 * Host endpoint router for one `sessionWorkerRouter` registration.
 *
 * A routed call never resolves a Typert descriptor or a local Agent; the
 * worker performs both in its own process.
 */
export class SessionWorkerRouter implements TypertEndpointRouter, SessionReminderDelivery {
  /**
   * @param ctx - host context carrying remote access and logging.
   * @param supervisor - worker process owner.
   * @param lives - live Session cache browser streams read from.
   */
  constructor(
    private readonly ctx: Context,
    private readonly supervisor: SessionWorkerSupervisor,
    private readonly lives: SessionWorkerLives | undefined,
    private readonly events: SessionWorkerEvents | undefined,
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
    const forwarded: RouteTarget = {
      sessionId: target.sessionId,
      args: this.withDefaultPreset(endpoint, target.args),
    }
    return this.forward(endpoint, route, forwarded, live, signal)
  }

  /**
   * Fill the Host's current default preset into a create that names none, so a
   * worker composes the preset the Settings page shows.
   * @param endpoint - routed endpoint.
   * @param args - forwarded arguments.
   * @returns the arguments to forward.
   */
  private withDefaultPreset(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (endpoint !== 'session/create') return args
    const request = requestOf(args)
    if (request === undefined || request['agentPreset'] !== undefined) return args
    const defaultId = this.ctx.get('agentPresets')?.defaultId
    return defaultId === undefined ? args : { ...args, request: { ...request, agentPreset: defaultId } }
  }

  /**
   * Deliver a Schedule reminder to the worker that owns the Session. This is
   * the Host port consulted by the Schedule service, so delivery never resumes
   * a second Agent in the Host process.
   * @param sessionId - Session whose Agent receives the reminder.
   * @param text - complete model-visible reminder text.
   * @param signal - optional cancellation of the local wait.
   * @returns the durable message identity reported by the worker.
   */
  async deliverReminder(
    sessionId: SessionId,
    text: string,
    signal: AbortSignal = NO_CANCELLATION,
  ): Promise<SessionDeliverValue> {
    const args = { request: { sessionId, text } }
    const route = SESSION_WRITES['session/deliverReminder']
    if (route === undefined) throw new Error('session-worker-host: reminder route is not registered')
    const result = await this.forward(
      'session/deliverReminder',
      route,
      { sessionId, args },
      this.supervisor.get(sessionId),
      signal,
    )
    if (!result.ok) throw new Error(result.error.message)
    return result.value as SessionDeliverValue
  }

  /**
   * Route a passive job observation stream to the worker that owns the
   * Session. No worker is spawned: a cold Session is served by the Host's own
   * empty job registry, which is the correct cold result.
   * @param endpoint - canonical Remote stream endpoint.
   * @param payload - complete wire payload, normally `{ args }`.
   * @param uplink - carrier uplink; job observation never reads it.
   * @param signal - carrier cancellation.
   * @param peer - caller the stream speaks for.
   * @returns the worker stream, or undefined when the Host owns the answer.
   */
  stream(
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    peer: PeerScope,
  ): AsyncIterable<unknown> | undefined {
    void uplink
    const readSession = SESSION_STREAMS[endpoint]
    if (readSession === undefined) return undefined
    const args = argsOf(payload)
    if (args === undefined) return undefined
    const sessionId = readSession(args)
    if (sessionId === undefined) return undefined
    const live = this.supervisor.get(sessionId)
    if (live === undefined) return undefined
    const reason = this.denial(endpoint, sessionId, args, peer)
    if (reason !== undefined) return failingStream(endpoint, reason)
    return live.open(endpoint, args, { signal })
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
    if (route.attachAfter !== true) this.attach(target.sessionId, worker)
    const result = await worker.call(endpoint, target.args, { signal })
    if (route.attachAfter === true && result.ok) this.attach(target.sessionId, worker)
    return this.attachWorkspace(endpoint, target, result)
  }

  /**
   * Write the new Session's Workspace membership in this process. The worker
   * created the Session but owns no Workspace projection; only the Host's
   * registry publishes membership to browsers.
   * @param endpoint - routed endpoint that may create a Session.
   * @param target - addressed Session and the forwarded arguments.
   * @param result - worker result to return unchanged when no attach applies.
   * @returns the worker result, or an attach failure naming the Session.
   */
  private async attachWorkspace(
    endpoint: string,
    target: RouteTarget,
    result: ConnectionRpcResult<unknown>,
  ): Promise<ConnectionRpcResult<unknown>> {
    if (!result.ok) return result
    if (endpoint !== 'session/create' && endpoint !== 'session/fork') return result
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return result
    const created = createdSessionId(result.value)
    if (created === undefined) return result
    let workspace: Workspace | undefined
    try {
      workspace = endpoint === 'session/create'
        ? requestedWorkspace(registry, target.args)
        : await resolveSessionWorkspaceFor(this.ctx, target.sessionId)
    } catch (error) {
      return workspaceAttachFailure(created, undefined, error)
    }
    if (workspace === undefined) return result
    try {
      await workspace.adoptSession(created)
    } catch (error) {
      return workspaceAttachFailure(created, workspace.id, error)
    }
    return result
  }

  /** Bind browser live state and the worker event relay to one generation. */
  private attach(sessionId: SessionId, worker: SessionWorkerHandle): void {
    this.lives?.attach(sessionId, worker)
    this.events?.attach(sessionId, worker)
  }

  private denied(
    endpoint: string,
    sessionId: SessionId,
    args: Readonly<Record<string, unknown>>,
    peer: PeerScope,
  ): ConnectionRpcResult<never> | undefined {
    const reason = this.denial(endpoint, sessionId, args, peer)
    if (reason === undefined) return undefined
    return {
      ok: false,
      error: {
        code: 'remote-access/denied',
        message: `remote access: ${endpoint}: access denied (${reason})`,
        details: { action: endpoint, reason },
      },
    }
  }

  private denial(
    endpoint: string,
    sessionId: SessionId,
    args: Readonly<Record<string, unknown>>,
    peer: PeerScope,
  ): string | undefined {
    // The owner short-circuits inside `decide`, so this only consults policies
    // for non-owner callers.
    const decision = this.ctx.remoteAccess.decide({
      principal: peer.principal,
      action: endpoint as RemoteAccessAction,
      resources: [{ kind: 'session', id: sessionId }],
      args,
    })
    return decision.kind === 'deny' ? decision.reason : undefined
  }
}

/**
 * A stream the Host refuses before any worker sees it. The first read raises
 * the same denial a unary call would return.
 * @param endpoint - canonical Remote stream endpoint.
 * @param reason - Host access-policy reason.
 * @returns an iterable that fails on its first step.
 */
function failingStream(endpoint: string, reason: string): AsyncIterable<never> {
  const error = new Error(`remote access: ${endpoint}: access denied (${reason})`)
  return { [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }) }
}

/** Session Remote methods carry one `request` object holding the identity. */
function requestField(field: string): RoutedWrite {
  return {
    session: (args) => {
      const request = requestOf(args)
      const sessionId = request === undefined ? undefined : readId(request, field)
      return sessionId === undefined ? undefined : { sessionId, args }
    },
    spawn: true,
  }
}

/** Methods whose wire arguments name the identity at the top level. */
function topLevelField(field: string): RoutedWrite {
  return {
    session: (args) => {
      const sessionId = readId(args, field)
      return sessionId === undefined ? undefined : { sessionId, args }
    },
    spawn: true,
  }
}

function requestOf(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const request = args['request']
  return typeof request === 'object' && request !== null && !Array.isArray(request)
    ? request as Record<string, unknown>
    : undefined
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

/** The Workspace a create request named, or undefined for a cwd-only create. */
function requestedWorkspace(registry: WorkspaceRegistry, args: Readonly<Record<string, unknown>>) {
  const request = requestOf(args)
  const workspaceId = request === undefined ? undefined : readWorkspaceId(request, 'workspaceId')
  return workspaceId === undefined ? undefined : registry.get(workspaceId)
}

function readWorkspaceId(
  args: Readonly<Record<string, unknown>>,
  field: string,
): WorkspaceId | undefined {
  const value = args[field]
  return typeof value === 'string' && value.length > 0 ? WorkspaceId(value) : undefined
}

/** The Session identity a create or fork result reports. */
function createdSessionId(value: unknown): SessionId | undefined {
  const result = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  return result === undefined ? undefined : readId(result, 'sessionId')
}

/** Report that the Session exists but its Host-side Workspace membership does not. */
function workspaceAttachFailure(
  sessionId: SessionId,
  workspaceId: WorkspaceId | undefined,
  error: unknown,
): ConnectionRpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'session/workspace-attach-failed',
      message: `session "${sessionId}" was created but could not attach to `
        + `${workspaceId === undefined ? 'its workspace' : `workspace "${workspaceId}"`}: ${String(error)}`,
      details: { sessionId, ...(workspaceId === undefined ? {} : { workspaceId }) },
    },
  }
}

function workerFailure(code: string, message: string): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details: {} } }
}

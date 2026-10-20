/**
 * Worker-side idle observation.
 *
 * The worker reports idle only when every ordinary Agent is idle, no assistant
 * stream is open, the Session log has been quiet for the configured window, no
 * background job is running or stopping, and no subagent child is progressing.
 * Passive streams (`session.follow`, `session.control`, `$events`) never
 * update the activity clock.
 *
 * @module @deepseek-ai/dsh-session-worker-bridge/idle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** One observation of the worker's idle conditions. */
export interface WorkerIdleSnapshot {
  /** Whether every condition holds. */
  readonly idle: boolean
  /** Stable explanation used in the notification frame. */
  readonly reason: string
}

/** Activity tracked by {@link WorkerIdleTracker}. */
export class WorkerIdleTracker {
  private lastActivityAt = Date.now()
  private readonly openAttempts = new Map<SessionId, Set<string>>()

  /**
   * @param ctx - worker context supplying live Agents, jobs, and subagents.
   * @param quietMs - how long the Session log must stay unchanged.
   */
  constructor(
    private readonly ctx: Context,
    private readonly quietMs: number,
  ) {
    if (!Number.isFinite(quietMs) || quietMs < 0) {
      throw new RangeError(`session-worker: quiet window must be a non-negative finite number, got ${String(quietMs)}`)
    }
  }

  /** Record work that postpones idleness. */
  noteActivity(): void {
    this.lastActivityAt = Date.now()
  }

  /** Record one durable Session mutation. */
  noteSessionEvent(): void {
    this.lastActivityAt = Date.now()
  }

  /** Track an opening/closing Assistant stream for one Agent. */
  noteAssistantFrame(agent: Agent, frame: AssistantStreamFrame): void {
    this.noteActivity()
    const attempts = this.openAttempts.get(agent.id) ?? new Set<string>()
    if (frame.type === 'start') {
      attempts.add(String(frame.attemptId))
      this.openAttempts.set(agent.id, attempts)
      return
    }
    if (frame.type === 'end') {
      attempts.delete(String(frame.attemptId))
      if (attempts.size === 0) this.openAttempts.delete(agent.id)
    }
  }

  /** Current idle conditions. */
  async inspect(now: number = Date.now()): Promise<WorkerIdleSnapshot> {
    const agents = this.ctx.agents.list()
    if (agents.some(agent => agent.status === 'running')) {
      return { idle: false, reason: 'agent-running' }
    }
    if (this.openAttempts.size > 0) {
      return { idle: false, reason: 'assistant-stream-open' }
    }
    if (now - this.lastActivityAt < this.quietMs) {
      return { idle: false, reason: 'quiet-window' }
    }
    const jobs = this.ctx.get('jobs')
    if (jobs !== undefined && agents.some(agent =>
      jobs.list(agent.id).some(job => job.status === 'running' || job.status === 'stopping'))) {
      return { idle: false, reason: 'job-running' }
    }
    const subagents = this.ctx.get('subagents')
    if (subagents !== undefined) {
      for (const agent of agents) {
        if (await subagents.waitForChildren(agent)) return { idle: false, reason: 'subagent-running' }
      }
    }
    return { idle: true, reason: 'quiet' }
  }

  /** Live Agent identities, used only for diagnostics. */
  get sessions(): readonly SessionId[] {
    return this.ctx.agents.list().map(agent => agent.id)
  }
}

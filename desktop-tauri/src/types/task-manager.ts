/** One process owned by the desktop shell, as returned by `get_task_manager_processes`. */
export interface TaskProcess {
  pid: number
  parent_pid: number | null
  name: string
  kind: 'desktop' | 'harness' | 'child'
  /** Memory-accounting bucket: the shell, a per-session worker, or everything else. */
  group: TaskProcessGroup
  cpu_percent: number | null
  memory_bytes: number
  run_time: number
  start_time: number
  can_end: boolean
}

/** Buckets shown by the memory indicator. */
export type TaskProcessGroup = 'desktop' | 'session-worker' | 'other'

import type { TaskProcess, TaskProcessGroup } from '@/types'

/** Display order of the indicator's memory buckets. */
export const MEMORY_GROUPS: readonly TaskProcessGroup[] = ['desktop', 'session-worker', 'other']

export interface MemoryGroupUsage {
  group: TaskProcessGroup
  count: number
  bytes: number
}

/** Sum one bucket per process; an unknown server-side group counts as `other`. */
export function groupMemory(processes: readonly TaskProcess[]): MemoryGroupUsage[] {
  const usage = new Map<TaskProcessGroup, MemoryGroupUsage>(
    MEMORY_GROUPS.map(group => [group, { group, count: 0, bytes: 0 }]),
  )
  for (const process of processes) {
    const entry = usage.get(process.group) ?? usage.get('other')
    if (entry === undefined)
      continue
    entry.count += 1
    entry.bytes += process.memory_bytes
  }
  return MEMORY_GROUPS.map(group => usage.get(group) as MemoryGroupUsage)
}

export function totalMemory(processes: readonly TaskProcess[]): number {
  return processes.reduce((sum, process) => sum + process.memory_bytes, 0)
}

/** Compact label for the chip: MB below 1 GB, one decimal above. */
export function formatMemory(bytes: number, locale: string): string {
  const gigabytes = bytes / 1024 / 1024 / 1024
  if (gigabytes >= 1) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gigabytes)} GB`
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024 / 1024)} MB`
}

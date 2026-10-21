import type { TaskProcess } from '@/types'
import { describe, expect, it } from 'vitest'
import { formatMemory, groupMemory, totalMemory } from './process-memory'

function processOf(group: TaskProcess['group'], memory: number): TaskProcess {
  return {
    pid: memory,
    parent_pid: null,
    name: 'node',
    kind: 'child',
    group,
    cpu_percent: null,
    memory_bytes: memory,
    run_time: 0,
    start_time: 0,
    can_end: true,
  }
}

describe('memory indicator grouping', () => {
  it('sums each bucket and keeps the display order', () => {
    const usage = groupMemory([
      processOf('other', 300),
      processOf('session-worker', 200),
      processOf('desktop', 100),
      processOf('session-worker', 50),
    ])
    expect(usage.map(entry => entry.group)).toEqual(['desktop', 'session-worker', 'other'])
    expect(usage.map(entry => entry.bytes)).toEqual([100, 250, 300])
    expect(usage.map(entry => entry.count)).toEqual([1, 2, 1])
  })

  it('counts an unknown server-side group as other', () => {
    const usage = groupMemory([processOf('plugin-child' as TaskProcess['group'], 42)])
    expect(usage.find(entry => entry.group === 'other')).toEqual({ group: 'other', count: 1, bytes: 42 })
  })

  it('totals every process', () => {
    expect(totalMemory([processOf('desktop', 1), processOf('other', 2)])).toBe(3)
    expect(totalMemory([])).toBe(0)
  })
})

describe('memory formatting', () => {
  it('uses MB below a gigabyte and one decimal for larger totals', () => {
    expect(formatMemory(0, 'en-US')).toBe('0 MB')
    expect(formatMemory(512 * 1024 * 1024, 'en-US')).toBe('512 MB')
    expect(formatMemory(1.5 * 1024 * 1024 * 1024, 'en-US')).toBe('1.5 GB')
  })
})

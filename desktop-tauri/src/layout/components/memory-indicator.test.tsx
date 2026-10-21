// @vitest-environment jsdom
import type { TaskProcess } from '@/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryIndicator } from './memory-indicator'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}))
vi.mock('@/ui/dialog/task-manager', () => ({ TaskManagerDialog: () => null }))

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

if (typeof CSS === 'undefined')
  vi.stubGlobal('CSS', { escape: (value: string) => value })

Element.prototype.getAnimations = function () {
  return []
}

const MB = 1024 * 1024

function processOf(group: TaskProcess['group'], memory: number, pid: number): TaskProcess {
  return {
    pid,
    parent_pid: null,
    name: 'node',
    kind: group === 'desktop' ? 'desktop' : 'child',
    group,
    cpu_percent: null,
    memory_bytes: memory,
    run_time: 0,
    start_time: 0,
    can_end: group === 'session-worker',
  }
}

const PROCESSES: TaskProcess[] = [
  processOf('desktop', 512 * MB, 1),
  processOf('session-worker', 512 * MB, 2),
  processOf('session-worker', 512 * MB, 3),
  processOf('other', 256 * MB, 4),
]

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mockIPC((cmd) => {
    if (cmd === 'get_task_manager_processes')
      return PROCESSES
    return undefined
  })
})

afterEach(() => {
  cleanup()
  clearMocks()
  queryClient.clear()
})

function renderIndicator() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryIndicator />
    </QueryClientProvider>,
  )
}

describe('memory indicator', () => {
  it('shows the process tree total and opens a grouped breakdown', async () => {
    renderIndicator()
    expect(await screen.findByText('1.8 GB')).not.toBeNull()

    fireEvent.click(screen.getByTestId('dsh-memory-indicator'))

    expect(await screen.findByTestId('dsh-memory-popover')).not.toBeNull()
    expect(screen.getByText('memory_indicator.group.desktop')).not.toBeNull()
    expect(screen.getByText('memory_indicator.group.session-worker')).not.toBeNull()
    expect(screen.getByText('memory_indicator.group.other')).not.toBeNull()
    expect(screen.getByText('512 MB')).not.toBeNull()
    expect(screen.getByText('1 GB')).not.toBeNull()
    expect(screen.getByText('256 MB')).not.toBeNull()
    expect(screen.getByText('×2')).not.toBeNull()
    expect(screen.getByText('memory_indicator.total')).not.toBeNull()
  })

  it('renders a placeholder until the first sample arrives', () => {
    mockIPC(() => new Promise(() => {}))
    renderIndicator()
    expect(screen.getByTestId('dsh-memory-indicator').textContent).toContain('—')
  })
})

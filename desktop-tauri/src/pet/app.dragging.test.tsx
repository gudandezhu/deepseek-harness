// @vitest-environment jsdom
import type { PetRef } from 'dsh-pet-component'
import { act, cleanup, render } from '@testing-library/react'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './app'

const state = vi.hoisted(() => ({
  drag: { dragging: false, direction: undefined as 'left' | 'right' | undefined },
  pet: null as PetRef | null,
}))

vi.mock('@gravity-ui/icons', () => ({
  CircleCheck: () => null,
  CircleExclamation: () => null,
  CircleInfo: () => null,
  TriangleExclamation: () => null,
}))
vi.mock('@/ui/pet/hint', () => ({ Hint: () => null }))
vi.mock('@/hooks/use-window-draggable', () => ({
  useWindowDraggable: () => ({ ...state.drag, onPointerDown: vi.fn(), onPointerUp: vi.fn() }),
}))
vi.mock('@/hooks/use-omit-ignore-cursor-events', () => ({ useOmitIgnoreCursorEvents: vi.fn() }))
vi.mock('../hooks/use-wakelock-release', () => ({ useWakelockRelease: vi.fn() }))
vi.mock('./hooks/use-pet-source', () => ({
  usePetSource: () => ({
    source: { kind: 'codex', config: { spriteVersionNumber: 2 }, uri: 'data:image/png;base64,AA==', cache: false },
    error: null,
  }),
}))
vi.mock('./hooks/use-pet-status', () => ({
  usePetStatus: () => ({ active_pet: 'codex:test', enabled: true, visible: true, pet_size: 100 }),
  normalizeSizePercent: (value: number) => value,
}))
vi.mock('./hooks/use-pet-physics', () => ({ usePetPhysics: () => ({ onFling: vi.fn(), onGrab: vi.fn(), onRelease: vi.fn() }) }))
vi.mock('./hooks/use-pet-window-clamp', () => ({
  usePetWindowClamp: () => ({ clampPosition: (position: unknown) => position, refreshWorkAreas: vi.fn() }),
}))
vi.mock('./hooks/use-pet-window', () => ({ usePetWindowSize: vi.fn() }))
vi.mock('./hooks/use-bubble-tracker', () => ({
  useBubbleTracker: (pet: PetRef) => {
    state.pet = pet
  },
}))

beforeEach(() => {
  vi.useFakeTimers()
  state.drag = { dragging: false, direction: undefined }
  state.pet = null
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('codex pet drag motion', () => {
  it('会话气泡存续时拖动方向优先，松手后恢复会话动画', () => {
    const view = render(<App />)
    const sprite = view.container.querySelector('.dsh-pet[data-motion]')!
    act(() => {
      state.pet!.bubble({ id: 'session', title: '会话', motion: 'working', timeout: 0 })
      vi.advanceTimersByTime(150)
    })
    expect(sprite.getAttribute('data-motion')).toBe('working')

    state.drag = { dragging: true, direction: 'left' }
    view.rerender(<App />)
    expect(sprite.getAttribute('data-motion')).toBe('moving-left')

    state.drag = { dragging: true, direction: 'right' }
    view.rerender(<App />)
    expect(sprite.getAttribute('data-motion')).toBe('moving-right')

    state.drag = { dragging: false, direction: undefined }
    view.rerender(<App />)
    expect(sprite.getAttribute('data-motion')).toBe('working')
  })

  it('拖动期间新到达的限时气泡动画不能覆盖方向', () => {
    state.drag = { dragging: true, direction: 'left' }
    const view = render(<App />)
    const sprite = view.container.querySelector('.dsh-pet[data-motion]')!
    expect(sprite.getAttribute('data-motion')).toBe('moving-left')

    act(() => {
      state.pet!.bubble({ id: 'done', title: '完成', motion: 'success', timeout: 2000 })
    })
    expect(sprite.getAttribute('data-motion')).toBe('moving-left')
  })
})

// @vitest-environment jsdom
import type { PetProps } from 'dsh-pet-component'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './app'

const native = vi.hoisted(() => ({ invoke: vi.fn(), report: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('./utils/log', () => ({ reportPetIssue: native.report }))
vi.mock('dsh-pet-component', () => ({
  Pet: (props: PetProps) => (
    <div data-testid="pet-hitbox" onDoubleClick={props.onDoubleClick} onContextMenu={props.onContextMenu} />
  ),
  useControllablePet: () => ({}),
}))
vi.mock('./hooks/use-pet-status', () => ({
  usePetStatus: () => ({ enabled: true, visible: true, active_pet: 'codex:cat', pet_size: 100 }),
  normalizeSizePercent: (size: number) => size,
}))
vi.mock('./hooks/use-pet-source', () => ({
  usePetSource: () => ({ source: { kind: 'codex', config: {}, uri: 'cat.png' }, error: null }),
}))
vi.mock('./hooks/use-bubble-tracker', () => ({ useBubbleTracker: vi.fn() }))
vi.mock('./hooks/use-pet-physics', () => ({ usePetPhysics: () => ({}) }))
vi.mock('./hooks/use-pet-window', () => ({ usePetWindowSize: vi.fn() }))
vi.mock('./hooks/use-pet-window-clamp', () => ({ usePetWindowClamp: () => ({}) }))
vi.mock('@/hooks/use-window-draggable', () => ({ useWindowDraggable: () => ({ dragging: false }) }))
vi.mock('@/hooks/use-omit-ignore-cursor-events', () => ({ useOmitIgnoreCursorEvents: vi.fn() }))
vi.mock('../hooks/use-wakelock-release', () => ({ useWakelockRelease: vi.fn() }))
vi.mock('@/ui/pet/hint', () => ({ Hint: () => null }))

beforeEach(() => {
  vi.resetAllMocks()
  native.invoke.mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('pet window interactions', () => {
  it('opens the main window on the component double-click event', () => {
    render(<App />)
    fireEvent.doubleClick(screen.getByTestId('pet-hitbox'))
    expect(native.invoke.mock.calls).toEqual([['pet_show_main_window']])
  })

  it('requests the native menu on the component context-menu event', () => {
    render(<App />)
    expect(fireEvent.contextMenu(screen.getByTestId('pet-hitbox'))).toBe(false)
    expect(native.invoke.mock.calls).toEqual([['pet_show_context_menu']])
  })

  it('does not open the main window on a single click', () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('pet-hitbox'))
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('suppresses the browser menu without showing the pet menu outside the body', () => {
    render(<App />)
    expect(fireEvent.contextMenu(screen.getByRole('main'))).toBe(false)
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('reports a failed main-window request', async () => {
    native.invoke.mockRejectedValueOnce(new Error('show failed'))
    render(<App />)
    fireEvent.doubleClick(screen.getByTestId('pet-hitbox'))
    await waitFor(() => expect(native.report).toHaveBeenCalledWith('show main window', new Error('show failed')))
  })

  it('reports a failed native-menu request', async () => {
    native.invoke.mockRejectedValueOnce(new Error('menu failed'))
    render(<App />)
    fireEvent.contextMenu(screen.getByTestId('pet-hitbox'))
    await waitFor(() => expect(native.report).toHaveBeenCalledWith('context menu', new Error('menu failed')))
  })
})

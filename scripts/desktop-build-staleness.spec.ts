import { describe, expect, it } from 'vitest'
import { isCurrent, signatureOf } from './desktop-build-staleness.ts'

describe('signatureOf', () => {
  it('separates a different HEAD or worktree state', () => {
    const base = signatureOf('abc', '')
    expect(signatureOf('def', '')).not.toBe(base)
    expect(signatureOf('abc', ' M packages/boot/config-editor/src/index.ts')).not.toBe(base)
    expect(signatureOf('abc', '')).toBe(base)
  })
})

describe('isCurrent', () => {
  const stamp = { signature: 'same', builtAt: '2026-10-21T00:00:00.000Z' }

  it('requires the recorded signature and every output', () => {
    expect(isCurrent(stamp, 'same', ['a', 'b'], () => true)).toBe(true)
    expect(isCurrent(undefined, 'same', ['a'], () => true)).toBe(false)
    expect(isCurrent(stamp, 'changed', ['a'], () => true)).toBe(false)
    expect(isCurrent(stamp, 'same', ['a', 'missing'], path => path !== 'missing')).toBe(false)
  })
})

/** Development reuse of a prepared primary runtime. */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { primaryRuntimeIsCurrent } from '../scripts/prepare-primary-runtime.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-primary-runtime-'))
  roots.push(root)
  return root
}

function prepare(root: string, modified: Date): string {
  const manifest = join(root, 'primary-runtime', 'runtime.json')
  mkdirSync(join(root, 'primary-runtime', 'dependencies'), { recursive: true })
  writeFileSync(manifest, '{}\n')
  utimesSync(manifest, modified, modified)
  return manifest
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('primary runtime development reuse', () => {
  it('reuses a payload prepared after every input last changed', () => {
    const root = fixture()
    const input = join(root, 'lock.json')
    writeFileSync(input, '{}\n')
    utimesSync(input, new Date(1_000), new Date(1_000))
    prepare(root, new Date(2_000))

    expect(primaryRuntimeIsCurrent(root, [input])).toBe(true)

    utimesSync(input, new Date(3_000), new Date(3_000))
    expect(primaryRuntimeIsCurrent(root, [input])).toBe(false)
  })

  it('rejects a missing manifest, payload directory, or input', () => {
    const root = fixture()
    expect(primaryRuntimeIsCurrent(root, [])).toBe(false)

    mkdirSync(join(root, 'primary-runtime'), { recursive: true })
    writeFileSync(join(root, 'primary-runtime', 'runtime.json'), '{}\n')
    expect(primaryRuntimeIsCurrent(root, [])).toBe(false)

    mkdirSync(join(root, 'primary-runtime', 'dependencies'), { recursive: true })
    expect(primaryRuntimeIsCurrent(root, [join(dirname(root), 'missing.json')])).toBe(false)
  })
})

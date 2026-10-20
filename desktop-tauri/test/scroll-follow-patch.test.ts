import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const rust = readFileSync(resolve('src-tauri/src/service/patch/scroll_follow.rs'), 'utf8')
const fixturePath = resolve('test/fixtures/scroll-follow-alpha5.txt')
const fixture = readFileSync(fixturePath, 'utf8')
const original = rust.match(/const ORIGINAL: &str = r#"([\s\S]*?)"#;/)?.[1]
const patched = rust.match(/const PATCHED: &str = r#"([\s\S]*?)"#;/)?.[1]
if (!original || !patched || fixture.split(original).length !== 2)
  throw new Error('Missing unique production scroll-follow patch anchor')

let directory: string | undefined

afterEach(() => {
  if (directory)
    rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function runContract(path: string) {
  return spawnSync(process.execPath, [resolve('test/fixtures/scroll-follow-contract.mjs'), path], {
    encoding: 'utf8',
    timeout: 20000,
  })
}

describe('scroll-follow reduced-motion startup patch', () => {
  it('satisfies the shared JavaScript contract with the production replacement', () => {
    directory = mkdtempSync(resolve('test/.scroll-follow-'))
    const target = resolve(directory, 'client.js')
    writeFileSync(target, fixture.replace(original, patched))
    const result = runContract(target)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toMatch(/# tests 38\b/)
    expect(result.stdout).toMatch(/# fail 0\b/)
  })

  it('rejects the released class without the document and early system guard', () => {
    const result = runContract(fixturePath)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('not ok 1 - root attribute presence')
    expect(result.stdout).toContain('policy system')
    expect(result.stdout).toMatch(/# tests 38\b/)
    expect(result.stdout).toMatch(/# fail [1-9]\d*\b/)
  })
})

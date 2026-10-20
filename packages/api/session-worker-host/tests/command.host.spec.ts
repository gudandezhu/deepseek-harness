/** Worker argv and environment derivation from the Host invocation. */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORWARDED_ENV,
  forwardedEnvironment,
  inheritedPatchArgs,
  sharedNodeFlags,
  workerCommand,
} from '../src/index.ts'

describe('session worker command derivation', () => {
  it('boots the same CLI entry and keeps shared Node flags', () => {
    expect(workerCommand('/usr/bin/node', ['--import', 'tsx/esm'], '/repo/apps/cli/src/bin.ts'))
      .toEqual(['/usr/bin/node', '--import', 'tsx/esm', '/repo/apps/cli/src/bin.ts'])
    expect(workerCommand('/usr/bin/node', [], '/repo/bin.ts')).toHaveLength(2)
    expect(() => workerCommand('/usr/bin/node', [], undefined)).toThrow(/argv\[1\]/)
  })

  it('drops inspector and test-runner flags that a child cannot share', () => {
    expect(sharedNodeFlags([
      '--inspect=9229', '--inspect', '--inspect-brk', '--import', 'tsx/esm', '--test', '--test-reporter', 'spec',
    ])).toEqual(['--import', 'tsx/esm'])
  })

  it('carries only patch overlays from the Host application arguments', () => {
    expect(inheritedPatchArgs([
      'web', '--no-open', '--port', '0', '--patch', '/tmp/a.yml', '--patch=/tmp/b.yml', '--other', '/tmp/c.yml',
    ])).toEqual(['--patch', '/tmp/a.yml', '--patch=/tmp/b.yml'])
    expect(inheritedPatchArgs(['--patch'])).toEqual([])
  })

  it('forwards deployment identity and credentials the subprocess scrub removes', () => {
    const forwarded = forwardedEnvironment(DEFAULT_FORWARDED_ENV, {
      DSH_HOME: '/tmp/home',
      DSH_SESSION_WORKER_IDLE_MS: '1500',
      DEEPSEEK_API_KEY: 'secret',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'unlisted',
      PATH: '/usr/bin',
      UNSET: undefined,
    })
    expect(forwarded).toEqual({
      DSH_HOME: '/tmp/home',
      DSH_SESSION_WORKER_IDLE_MS: '1500',
      DEEPSEEK_API_KEY: 'secret',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
    })
    expect(forwardedEnvironment(['EXACT', 'PRE_*'], { EXACT: '1', PREFIXED: '2', PRE_: '3' }))
      .toEqual({ EXACT: '1', PRE_: '3' })
  })
})

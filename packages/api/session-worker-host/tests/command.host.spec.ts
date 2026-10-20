/** Worker argv and environment derivation from the Host invocation. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FORWARDED_ENV,
  electronWorkerCommand,
  forwardedEnvironment,
  hostWorkerCommand,
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

  it('boots the bundled CLI under Electron when the host exposes its runtime directory', () => {
    expect(electronWorkerCommand('/app/Electron', '/app/runtime')).toEqual([
      '/app/Electron',
      '--expose-internals',
      join('/app/runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ])
    expect(electronWorkerCommand('/app/Electron', undefined)).toBeUndefined()
    expect(electronWorkerCommand('/app/Electron', '')).toBeUndefined()
  })

  it('selects the Electron command over the desktop host entry', () => {
    expect(hostWorkerCommand({
      electron: true,
      execPath: '/app/Electron',
      execArgv: ['--inspect=9229'],
      entry: '/app/desktop-host/lib/index.js',
      runtimeDir: '/app/runtime',
    })).toEqual([
      '/app/Electron',
      '--expose-internals',
      join('/app/runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ])
    expect(hostWorkerCommand({
      electron: false,
      execPath: '/usr/bin/node',
      execArgv: ['--import', 'tsx/esm'],
      entry: '/repo/apps/cli/src/bin.ts',
      runtimeDir: undefined,
    })).toEqual(['/usr/bin/node', '--import', 'tsx/esm', '/repo/apps/cli/src/bin.ts'])
    expect(() => hostWorkerCommand({
      electron: true,
      execPath: '/app/Electron',
      execArgv: [],
      entry: '/app/desktop-host/lib/index.js',
      runtimeDir: undefined,
    })).toThrow(/runtime directory/)
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

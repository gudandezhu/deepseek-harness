import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePresetCachePath, resolveSettingsFilePath } from './paths'

describe('resolveSettingsFilePath', () => {
  it('uses a non-blank DSH_HOME', () => {
    expect(resolveSettingsFilePath({ DSH_HOME: 'D:\\harness' } as NodeJS.ProcessEnv))
      .toBe(resolve('D:\\harness', 'cordis.patch.yml'))
  })

  it('falls back to ~/.dsh when DSH_HOME is unset or blank', () => {
    const expected = join(homedir(), '.dsh', 'cordis.patch.yml')
    expect(resolveSettingsFilePath({} as NodeJS.ProcessEnv)).toBe(expected)
    expect(resolveSettingsFilePath({ DSH_HOME: '   ' } as NodeJS.ProcessEnv)).toBe(expected)
  })

  it('expands a leading tilde', () => {
    expect(resolveSettingsFilePath({ DSH_HOME: '~/custom' } as NodeJS.ProcessEnv))
      .toBe(join(homedir(), 'custom', 'cordis.patch.yml'))
  })
})

describe('resolvePresetCachePath', () => {
  it('keeps the cache under the plugin directory in DSH_HOME', () => {
    expect(resolvePresetCachePath({ DSH_HOME: 'D:\\harness' } as NodeJS.ProcessEnv))
      .toBe(resolve('D:\\harness', 'dsh-tauri-model', 'model-presets.json'))
  })
})

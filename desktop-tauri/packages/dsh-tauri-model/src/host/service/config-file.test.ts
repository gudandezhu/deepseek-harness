import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDirectory, openUrl } from 'dsh-tauri'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configFile } from './config-file'

vi.mock('dsh-tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dsh-tauri')>()
  return { ...actual, openDirectory: vi.fn(), openUrl: vi.fn() }
})

describe('config file open', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-config-open-'))
    vi.stubEnv('DSH_HOME', home)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    await rm(home, { recursive: true, force: true })
  })

  it('opens the shared config file with the system default', async () => {
    await writeFile(join(home, 'cordis.patch.yml'), '- id: shared\n')
    expect(await configFile.open()).toEqual({ ok: true, path: join(home, 'cordis.patch.yml'), opened: 'file' })
    expect(openUrl).toHaveBeenCalledWith(join(home, 'cordis.patch.yml'))
    expect(openDirectory).not.toHaveBeenCalled()
  })

  it('opens the containing directory when the shared config does not exist', async () => {
    expect(await configFile.open()).toEqual({ ok: true, path: home, opened: 'directory' })
    expect(openDirectory).toHaveBeenCalledWith(home)
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('treats a directory named cordis.patch.yml as no config file and opens the containing directory', async () => {
    await mkdir(join(home, 'cordis.patch.yml'))
    expect(await configFile.open()).toEqual({ ok: true, path: home, opened: 'directory' })
    expect(openDirectory).toHaveBeenCalledWith(home)
  })

  it('reports launcher failure instead of silently opening a different app', async () => {
    await writeFile(join(home, 'cordis.patch.yml'), '- id: shared\n')
    vi.mocked(openUrl).mockRejectedValueOnce(new Error('No default application'))
    expect(await configFile.open()).toEqual({ ok: false, path: join(home, 'cordis.patch.yml'), error: 'No default application' })
    expect(openDirectory).not.toHaveBeenCalled()
  })
})

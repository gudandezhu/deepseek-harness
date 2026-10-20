/** Desktop resource locations and signing-aware verification for the shared runtime builder. */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePrimaryRuntime as preparePayload, smokePrimaryRuntime as smokePayload } from '../../../scripts/primary-runtime/prepare.ts'
import { parsePrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { scrubWindowsSigningEnvironment } from './windows-sign.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Inputs whose change invalidates a prepared primary runtime. */
const PRIMARY_RUNTIME_INPUTS = [
  join(REPOSITORY_ROOT, 'scripts', 'primary-runtime', 'lock.json'),
  join(REPOSITORY_ROOT, 'pnpm-lock.yaml'),
  join(REPOSITORY_ROOT, 'apps', 'desktop', 'package.json'),
] as const

/**
 * Whether the prepared payload is at least as new as every locked input.
 * @param runtimeRoot - Desktop build runtime directory containing `primary-runtime/`.
 * @param inputs - Files whose modification invalidates the payload.
 * @returns true when the payload can be reused without preparing or smoking it.
 */
export function primaryRuntimeIsCurrent(
  runtimeRoot: string,
  inputs: readonly string[] = PRIMARY_RUNTIME_INPUTS,
): boolean {
  const runtime = join(runtimeRoot, 'primary-runtime')
  const manifestPath = join(runtime, 'runtime.json')
  if (!existsSync(manifestPath) || !existsSync(join(runtime, 'dependencies'))) return false
  const preparedAt = statSync(manifestPath).mtimeMs
  return inputs.every(input => existsSync(input) && statSync(input).mtimeMs <= preparedAt)
}

/** Options for preparing the Desktop primary runtime. */
export interface PreparePrimaryRuntimeOptions {
  /** Skip the native interpreter and Office round-trip smoke checks. */
  readonly deferSmoke?: boolean
  /** Reuse a payload prepared after every locked input last changed. */
  readonly reuse?: boolean
}

/**
 * Prepare Desktop resources for its selected packaging target.
 * @param options - Smoke deferral or development reuse; signed Windows packaging defers execution until its supervised signing stage.
 * @returns Resolves after preparation and, unless deferred, native-target execution checks.
 */
export async function preparePrimaryRuntime(options: PreparePrimaryRuntimeOptions = {}): Promise<void> {
  const paths = resolveDesktopTargetBuildPaths()
  if (options.reuse === true && primaryRuntimeIsCurrent(paths.runtime)) return
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  await preparePayload({ target: resolveDesktopBuildTarget(), output: paths.runtime, cache: paths.downloads, version })
  if (!options.deferSmoke) smokePrimaryRuntime(join(paths.runtime, 'primary-runtime'))
}

/**
 * Verify Desktop's complete payload after preparation or platform signing.
 * @param root - Final payload directory, including any platform signatures.
 */
export function smokePrimaryRuntime(root: string): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  if (entries.node === undefined || entries.pnpm === undefined) throw new Error('primary runtime: the Desktop payload must declare node and pnpm components.')
  smokePayload(root, scrubWindowsSigningEnvironment(process.env))
}

if (import.meta.main) await preparePrimaryRuntime()

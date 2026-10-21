/**
 * Rebuild the desktop kernel and plugin artifacts only when their inputs changed.
 * `just dev-desktop` runs this before Tauri, so one command picks up source
 * edits without paying a full rebuild on every launch. The stamp lives beside
 * the local-kernel shim, keyed by HEAD plus the worktree state of build inputs.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { isCurrent, type BuildStamp, signatureOf } from './desktop-build-staleness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const STAMP_PATH = join(ROOT, 'desktop-tauri', '.local-kernel', 'build-stamp.json')

/** Files that determine one artifact set: where it reads and what must exist afterwards. */
interface Target {
  readonly key: string
  readonly label: string
  readonly cwd: string
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  readonly args: readonly string[]
}

const ROOT_BUILD_INPUTS = [
  'apps',
  'packages',
  'vendor',
  'patches',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.base.client.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsconfig.node.base.json',
  'tsdown.config.ts',
] as const

const DESKTOP_BUILD_INPUTS = [
  'desktop-tauri/packages',
  'desktop-tauri/scripts',
  'desktop-tauri/package.json',
  'desktop-tauri/pnpm-lock.yaml',
  'desktop-tauri/pnpm-workspace.yaml',
  'desktop-tauri/tsconfig.json',
  'desktop-tauri/tooling.config.ts',
] as const

const TARGETS: readonly Target[] = [
  {
    key: 'kernel',
    label: '内核',
    cwd: ROOT,
    inputs: ROOT_BUILD_INPUTS,
    outputs: ['apps/cli/lib/bin.js'],
    args: ['run', 'build:artifacts'],
  },
  {
    key: 'plugins',
    label: '桌面插件',
    cwd: join(ROOT, 'desktop-tauri'),
    inputs: DESKTOP_BUILD_INPUTS,
    outputs: [
      'desktop-tauri/packages/dsh-tauri-model/dist/index.js',
      'desktop-tauri/src-tauri/resources/node_modules/dsh-tauri-model/package.json',
    ],
    args: ['run', 'build:plugins'],
  },
]

/** Read stamps; a missing or unreadable file means every target rebuilds once. */
function readStamps(): Record<string, BuildStamp> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STAMP_PATH, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, BuildStamp>
      : {}
  }
  catch {
    return {}
  }
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function targetSignature(target: Target): string {
  return signatureOf(
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...target.inputs]),
  )
}

/** Run the package-manager subprocess, preferring the pnpm entry that launched this script. */
function runPnpm(target: Target): void {
  const entry = process.env.npm_execpath
  const javascriptEntry = entry !== undefined && entry !== '' && /\.(?:c|m)?js$/.test(entry)
  const command = javascriptEntry ? process.execPath : 'pnpm'
  const args = javascriptEntry ? [entry, ...target.args] : [...target.args]
  const result = spawnSync(command, args, {
    cwd: target.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !javascriptEntry,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${target.label}构建失败（pnpm ${target.args.join(' ')}，退出码 ${String(result.status)}）`)
}

const stamps = readStamps()
const next: Record<string, BuildStamp> = {}
let rebuilt = false

for (const target of TARGETS) {
  const before = targetSignature(target)
  if (isCurrent(stamps[target.key], before, target.outputs, path => existsSync(join(ROOT, path)))) {
    next[target.key] = stamps[target.key] as BuildStamp
    continue
  }
  rebuilt = true
  console.log(`[dev-desktop] ${target.label}产物过期，开始重建…`)
  runPnpm(target)
  const after = targetSignature(target)
  if (after === before) {
    next[target.key] = { signature: before, builtAt: new Date().toISOString() }
  }
  else console.warn(`[dev-desktop] ${target.label}构建期间输入又发生变化，下次启动会再重建`)
}

mkdirSync(dirname(STAMP_PATH), { recursive: true })
writeFileSync(STAMP_PATH, `${JSON.stringify(next, null, 2)}\n`)
if (!rebuilt) console.log('[dev-desktop] 内核与桌面插件产物已是最新，跳过构建')

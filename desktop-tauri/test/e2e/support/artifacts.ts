import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

interface PluginManifest {
  main?: string
  exports?: Record<string, string | { default?: string }>
}

const EXCLUDED_DIRECTORIES = new Set(['archive', 'dist', 'node_modules', 'target', 'test', 'tests', '__tests__'])

function inputFiles(path: string): string[] {
  if (!existsSync(path))
    return []
  if (statSync(path).isFile())
    return [path]
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(entry.name))
      return []
    if (/\.(?:test|spec)\.[^.]+$/.test(entry.name))
      return []
    if (entry.name === 'index.ts' && path.endsWith(join('dsh-tauri-ui', 'src', 'client', 'styles')))
      return []
    return inputFiles(join(path, entry.name))
  })
}

export function assertDesktopArtifactsCurrent(repoRoot: string, binaryPath: string): void {
  const frontend = join(repoRoot, 'dist', 'index.html')
  const checks = [
    {
      entry: binaryPath,
      inputs: [
        'src-tauri/src',
        'src-tauri/build.rs',
        'src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock',
        'src-tauri/tauri.conf.json',
        'src-tauri/resources/manifest.jsonc',
        'dist/index.html',
      ],
    },
    {
      entry: frontend,
      inputs: ['src', 'index.html', 'vite.config.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    },
  ]
  for (const { entry, inputs } of checks) {
    if (!existsSync(entry))
      throw new Error(`桌面 E2E 缺少构建产物：${entry}；请交由 CI 构建后验证。`)
    const builtAt = statSync(entry).mtimeMs
    const newerInput = inputs.flatMap(path => inputFiles(join(repoRoot, path)))
      .find(input => statSync(input).mtimeMs > builtAt)
    if (newerInput)
      throw new Error(`桌面 E2E 构建产物已过期：${relative(repoRoot, newerInput)} 新于 ${entry}；请交由 CI 构建，禁止启动旧产物。`)
  }
}

export function assertPluginArtifactsCurrent(repoRoot: string, pkg: string): void {
  const pkgDir = join(repoRoot, 'packages', pkg)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PluginManifest
  const client = manifest.exports?.['./client']
  const clientEntry = typeof client === 'string' ? client : client?.default
  const entries = [manifest.main ?? './dist/index.js', ...(clientEntry ? [clientEntry] : [])]
    .map(entry => join(pkgDir, entry))
  for (const entry of entries) {
    if (!existsSync(entry))
      throw new Error(`${pkg} 尚未构建：缺少 ${entry}；请在 CI 运行 pnpm build:plugins。`)
  }
  const inputs = [
    join(pkgDir, 'src'),
    join(pkgDir, 'scripts'),
    join(pkgDir, 'package.json'),
    join(pkgDir, 'tsdown.config.ts'),
    join(repoRoot, 'packages', 'dsh-tauri-tsdown', 'src'),
    ...['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tailwind.config.js', 'tailwind.plugins.config.js']
      .map(file => join(repoRoot, file)),
  ].flatMap(inputFiles)
  const oldestEntry = Math.min(...entries.map(entry => statSync(entry).mtimeMs))
  const newerInput = inputs.find(input => statSync(input).mtimeMs > oldestEntry)
  if (newerInput)
    throw new Error(`${pkg} 构建产物已过期：${relative(repoRoot, newerInput)} 新于运行入口；请在 CI 运行 pnpm build:plugins 后验证，不能用旧产物宣称通过。`)
}

/** Derive the worker argv from the running CLI invocation. */

/**
 * Select Host environment entries a worker must share.
 *
 * The subprocess provider scrubs every `DSH_*` name and every credential-shaped
 * name from an inherited environment, which would give a worker a different
 * Harness home or no model credential. A pattern ending in `*` matches a
 * prefix; every other pattern matches the exact name.
 * @param patterns - exact names and `prefix*` patterns.
 * @param source - environment to read; defaults to this process.
 * @returns matching defined values.
 */
export function forwardedEnvironment(
  patterns: readonly string[],
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    const matches = patterns.some(pattern => pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : name === pattern)
    if (matches) forwarded[name] = value
  }
  return forwarded
}

/** Deployment environment names a session worker shares with its Host. */
export const DEFAULT_FORWARDED_ENV: readonly string[] = ['DSH_*', 'DEEPSEEK_*']

/** Node flags that must not be shared with a child process. */
const EXCLUSIVE_NODE_FLAGS: ReadonlySet<string> = new Set([
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--test',
  '--test-reporter',
  '--test-reporter-destination',
])

/** Exclusive flags that may consume the following argument as their value. */
const EXCLUSIVE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--inspect-port',
  '--test-reporter',
  '--test-reporter-destination',
])

/**
 * Build the argv prefix that boots the same CLI this Host runs.
 *
 * This derivation assumes the Host itself runs `@deepseek-ai/dsh/lib/bin.js`.
 * Desktop/Electron does not: its host process is
 * `@deepseek-ai/dsh-desktop-host`, whose entry takes positional runtime
 * arguments and would reboot the desktop host instead of a worker profile.
 * Such an embedder must set the plugin's `command` (and `env`) explicitly:
 *
 * ```yaml
 * - id: session-worker-host
 *   config:
 *     command:
 *       - <electron executable>
 *       - --expose-internals
 *       - <runtimeDir>/node_modules/@deepseek-ai/dsh/lib/bin.js
 *     env:
 *       ELECTRON_RUN_AS_NODE: '1'
 * ```
 *
 * `runtimeDir` is the Desktop host's `process.argv[2]`; the CLI entry is
 * `@deepseek-ai/dsh`'s `bin` field. `DSH_HOME` and provider credentials travel
 * through the default forwarded environment. This desktop path has no
 * automated test in this repository: every e2e host here boots the CLI
 * directly, so a packaged Electron launch must be verified by hand.
 *
 * @param execPath - Node executable.
 * @param execArgv - Node flags of the Host process.
 * @param entry - CLI entry point (`process.argv[1]`).
 * @returns executable plus arguments, without a profile.
 */
export function workerCommand(
  execPath: string,
  execArgv: readonly string[],
  entry: string | undefined,
): string[] {
  if (entry === undefined || entry === '') {
    throw new Error('session-worker-host: process.argv[1] does not name the CLI entry point')
  }
  return [execPath, ...sharedNodeFlags(execArgv), entry]
}

/**
 * Keep only Node flags a child may own independently.
 * @param execArgv - Host Node flags.
 * @returns flags without inspector or test-runner modes.
 */
export function sharedNodeFlags(execArgv: readonly string[]): string[] {
  const kept: string[] = []
  for (let index = 0; index < execArgv.length; index += 1) {
    const flag = execArgv[index] as string
    const name = flag.split('=', 1)[0] ?? flag
    if (EXCLUSIVE_NODE_FLAGS.has(name)) {
      if (EXCLUSIVE_VALUE_FLAGS.has(name) && !flag.includes('=')) index += 1
      continue
    }
    kept.push(flag)
  }
  return kept
}

/**
 * Carry patch overlays from the Host invocation to the worker so both
 * processes compose the same deployment configuration.
 * @param argv - arguments after the executable and entry point.
 * @returns the `--patch` pairs in their original order.
 */
export function inheritedPatchArgs(argv: readonly string[]): string[] {
  const args: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string
    if (value === '--patch') {
      const next = argv[index + 1]
      if (next !== undefined) {
        args.push(value, next)
        index += 1
      }
      continue
    }
    if (value.startsWith('--patch=')) args.push(value)
  }
  return args
}

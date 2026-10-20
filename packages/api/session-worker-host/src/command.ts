/** Derive the worker argv from the running CLI invocation. */

/** Node flags that must not be shared with a child process. */
const EXCLUSIVE_NODE_FLAGS: ReadonlySet<string> = new Set([
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--test',
  '--test-reporter',
  '--test-reporter-destination',
])

/**
 * Build the argv prefix that boots the same CLI this Host runs.
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
  for (const flag of execArgv) {
    const name = flag.split('=', 1)[0] ?? flag
    if (EXCLUSIVE_NODE_FLAGS.has(name)) continue
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

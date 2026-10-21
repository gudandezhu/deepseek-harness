/** Staleness facts shared by the desktop dev-build guard and its test. */
import { createHash } from 'node:crypto'

/** One target's last successful build, keyed by the inputs that produced it. */
export interface BuildStamp {
  readonly signature: string
  readonly builtAt: string
}

/** Identity of the build inputs: HEAD plus the worktree state of the input paths. */
export function signatureOf(head: string, status: string): string {
  return createHash('sha256').update(head).update('\0').update(status).digest('hex')
}

/** Whether a recorded build already covers this signature and every output exists. */
export function isCurrent(
  record: BuildStamp | undefined,
  signature: string,
  outputs: readonly string[],
  exists: (path: string) => boolean,
): boolean {
  return record?.signature === signature && outputs.every(exists)
}

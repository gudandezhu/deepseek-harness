import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { describe, expect, it } from 'vitest'

const rust = readFileSync(new URL('../src-tauri/src/service/patch/mcp_startup.rs', import.meta.url), 'utf8')
const readySource = /const READY_PATCHED: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1]
if (!readySource)
  throw new Error('MCP readiness patch source is missing')

interface Outcome { error?: Error }

function activate(ready: Promise<Outcome>, failOnStartupError = false, logError = (_error: string) => {}): Promise<void> {
  const apply = compileFunction(`return (async () => {
${readySource}
if (outcome.error !== undefined && config.failOnStartupError)
  throw new Error('initial connection or tool synchronization failed', { cause: outcome.error });
})()`, ['connection', 'config', 'ctx'])
  return apply({ ready }, { failOnStartupError, serverName: 'test' }, { logger: { error: logError } }) as Promise<void>
}

describe('mcp startup readiness', () => {
  it('activates a non-strict MCP while its initial connection is still pending', async () => {
    const ready = Promise.withResolvers<Outcome>()
    let activated = false
    const activation = activate(ready.promise).then(() => {
      activated = true
    })
    await new Promise<void>(resolve => queueMicrotask(resolve))
    try {
      expect(activated).toBe(true)
    }
    finally {
      ready.resolve({})
      await activation
    }
  })

  it('logs an unexpected background rejection without failing activation', async () => {
    const ready = Promise.withResolvers<Outcome>()
    const errors: string[] = []
    await activate(ready.promise, false, error => errors.push(error))
    ready.reject(new Error('transport construction failed'))
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(errors).toEqual(['mcp-client(test): background startup failed: Error: transport construction failed'])
  })

  it('keeps explicit strict startup pending until discovery succeeds', async () => {
    const ready = Promise.withResolvers<Outcome>()
    let activated = false
    const activation = activate(ready.promise, true).then(() => {
      activated = true
    })
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(activated).toBe(false)
    ready.resolve({})
    await activation
    expect(activated).toBe(true)
  })

  it('preserves the original connection failure as the strict startup error cause', async () => {
    const error = new Error('MCP unavailable')
    await expect(activate(Promise.resolve({ error }), true)).rejects.toMatchObject({
      message: 'initial connection or tool synchronization failed',
      cause: error,
    })
  })
})

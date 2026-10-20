/** Staged upload receipts survive the process that accepted them. */

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RECEIPT_TTL_MS, StagedReceiptStore } from '../src/receipt-store.ts'
import type { FileUploadReceiptId } from '../src/types.ts'

const sessionId = 'session-receipts' as SessionId
const file: FileAttachmentRef = {
  attachmentId: 'sha256:aa' as FileAttachmentRef['attachmentId'],
  name: 'notes.txt',
  bytes: 4,
}
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })))
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-receipt-store-'))
  roots.push(directory)
  return directory
}

function receipt(id: string): FileUploadReceiptId {
  return id as FileUploadReceiptId
}

describe('Staged upload receipt store', () => {
  it('lets a fresh store instance resolve an existing receipt', async () => {
    const directory = await root()
    const first = new StagedReceiptStore(directory)
    first.put(sessionId, receipt('receipt-1'), { file })

    const second = new StagedReceiptStore(directory)
    expect(second.get(sessionId, receipt('receipt-1'))).toEqual(file)
  })

  it('writes atomically and keeps arbitrary Session ids inside the root', async () => {
    const directory = await root()
    const store = new StagedReceiptStore(directory)
    const escaped = '../../escape' as SessionId
    store.put(escaped, receipt('receipt-2'), { file })

    const entries = await readdir(directory)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^[0-9a-f]{64}\.json$/)
    expect(new StagedReceiptStore(directory).get(escaped, receipt('receipt-2'))).toEqual(file)
  })

  it('persists prompt bindings, restores them, and removes the document after retirement', async () => {
    const directory = await root()
    const store = new StagedReceiptStore(directory)
    store.put(sessionId, receipt('receipt-3'), { file })
    const bound = store.bind(sessionId, [receipt('receipt-3')], 'request-1')
    expect(bound).toEqual([{ receiptId: receipt('receipt-3'), previous: undefined }])

    store.restore(sessionId, bound ?? [])
    new StagedReceiptStore(directory).retire(sessionId, 'request-1')
    expect(new StagedReceiptStore(directory).get(sessionId, receipt('receipt-3'))).toEqual(file)

    expect(store.bind(sessionId, [receipt('receipt-3')], 'request-1')).toBeDefined()
    store.retire(sessionId, 'request-1')
    expect(store.get(sessionId, receipt('receipt-3'))).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
  })

  it('prunes an unconsumed receipt after the retention window', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const directory = await root()
      new StagedReceiptStore(directory).put(sessionId, receipt('receipt-old'), { file })
      vi.setSystemTime(1_000_000 + RECEIPT_TTL_MS + 1)
      const later = new StagedReceiptStore(directory)
      expect(later.get(sessionId, receipt('receipt-old'))).toBeUndefined()
      expect(await readdir(directory)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reloads from disk after the hot copy is forgotten', async () => {
    const directory = await root()
    const store = new StagedReceiptStore(directory)
    store.put(sessionId, receipt('receipt-4'), { file })
    store.forget(sessionId)
    expect(store.get(sessionId, receipt('receipt-4'))).toEqual(file)
  })

  it('ignores a corrupt document and reports it', async () => {
    const directory = await root()
    const warn = vi.fn()
    const path = join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
    await writeFile(path, '{not json')
    const store = new StagedReceiptStore(directory, warn)
    expect(store.get(sessionId, receipt('missing'))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not JSON'))
  })

  it('reads back exactly the receipt document it wrote', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(5_000)
      const directory = await root()
      const store = new StagedReceiptStore(directory)
      store.put(sessionId, receipt('receipt-5'), { file, requestId: 'request-5' })
      const path = join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        version: 1,
        sessionId,
        receipts: { 'receipt-5': { file, requestId: 'request-5', createdAt: 5_000 } },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Session-keyed staged upload receipts shared across worker generations.
 *
 * A receipt outlives the process that accepted the upload: the browser uploads
 * against the Host, the prompt that consumes the receipt enters the worker that
 * owns the Session, and the next worker generation must resolve the same
 * receipt after an idle exit. The store therefore keeps a small JSON document
 * per Session under the Harness cache, written atomically and read
 * synchronously because prompt admission resolves receipts without awaiting.
 *
 * @module @deepseek-ai/dsh-client-file-upload/receipt-store
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileUploadReceiptId } from './types.ts'

/** One staged upload; `requestId` names the prompt that accepted it. */
export interface StagedFileUpload {
  readonly file: FileAttachmentRef
  /** Prompt that accepted this receipt; absent until successful admission. */
  requestId?: string
  /** When the receipt was staged; used to prune uploads no prompt consumed. */
  readonly createdAt?: number
}

/** Unconsumed receipts older than this are dropped when their document loads. */
export const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000

/** One receipt's prompt binding before {@link StagedReceiptStore.bind}. */
export interface BoundReceipt {
  readonly receiptId: FileUploadReceiptId
  readonly previous: string | undefined
}

/** On-disk receipt document, versioned for future migrations. */
interface ReceiptDocument {
  readonly version: 1
  readonly sessionId: string
  readonly receipts: Readonly<Record<string, {
    readonly file: FileAttachmentRef
    readonly requestId?: string
    readonly createdAt?: number
  }>>
}

const DOCUMENT_VERSION = 1

/** Opaque cache leaf name; hashing keeps arbitrary Session ids inside the root. */
function fileFor(root: string, sessionId: SessionId): string {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  return join(root, `${digest}.json`)
}

/** One cache directory of Session receipts. */
export class StagedReceiptStore {
  private readonly sessions = new Map<SessionId, Map<FileUploadReceiptId, StagedFileUpload>>()

  /**
   * @param root - private cache directory; created on the first write.
   * @param warn - diagnostic sink for unreadable documents.
   */
  constructor(
    private readonly root: string,
    private readonly warn: (message: string) => void = () => {},
  ) {}

  /**
   * Look up one staged receipt, loading its Session document on first use.
   * @param sessionId - Session that owns the receipt.
   * @param receiptId - opaque receipt identity.
   * @returns the durable file reference, or undefined when absent.
   */
  get(sessionId: SessionId, receiptId: FileUploadReceiptId): FileAttachmentRef | undefined {
    return this.load(sessionId).get(receiptId)?.file
  }

  /**
   * Stage one receipt and write its Session document atomically.
   * @param sessionId - Session that owns the receipt.
   * @param receiptId - freshly minted receipt identity.
   * @param upload - staged upload to persist.
   */
  put(sessionId: SessionId, receiptId: FileUploadReceiptId, upload: StagedFileUpload): void {
    this.load(sessionId).set(receiptId, { ...upload, createdAt: upload.createdAt ?? Date.now() })
    this.persist(sessionId)
  }

  /**
   * Record the prompt that accepted each receipt and persist the document.
   * @param sessionId - Session that owns the receipts.
   * @param receiptIds - distinct receipts referenced by the prompt.
   * @param requestId - prompt identity later observed in queue or history.
   * @returns previous bindings to restore on rollback, or undefined when any receipt is absent.
   */
  bind(
    sessionId: SessionId,
    receiptIds: readonly FileUploadReceiptId[],
    requestId: string,
  ): readonly BoundReceipt[] | undefined {
    const staged = this.load(sessionId)
    const bound: BoundReceipt[] = []
    for (const receiptId of receiptIds) {
      const upload = staged.get(receiptId)
      if (upload === undefined) return undefined
      bound.push({ receiptId, previous: upload.requestId })
    }
    for (const { receiptId } of bound) {
      const upload = staged.get(receiptId)
      if (upload !== undefined) upload.requestId = requestId
    }
    this.persist(sessionId)
    return bound
  }

  /**
   * Undo {@link bind} after a prompt was not delivered.
   * @param sessionId - Session that owns the receipts.
   * @param bound - bindings returned by {@link bind}.
   */
  restore(sessionId: SessionId, bound: readonly BoundReceipt[]): void {
    const staged = this.load(sessionId)
    for (const { receiptId, previous } of bound) {
      const upload = staged.get(receiptId)
      if (upload === undefined) continue
      if (previous === undefined) delete upload.requestId
      else upload.requestId = previous
    }
    this.persist(sessionId)
  }

  /**
   * Remove every receipt accepted by one prompt and persist the result.
   * @param sessionId - Session that owns the receipts.
   * @param requestId - prompt identity recorded on accepted receipts.
   */
  retire(sessionId: SessionId, requestId: string): void {
    const staged = this.load(sessionId)
    let changed = false
    for (const [receiptId, upload] of staged) {
      if (upload.requestId !== requestId) continue
      staged.delete(receiptId)
      changed = true
    }
    if (changed) this.persist(sessionId)
  }

  /**
   * Drop the in-memory copy without touching disk. A later reader, including a
   * fresh worker, reloads the durable receipts.
   * @param sessionId - Session whose cache entry is no longer hot.
   */
  forget(sessionId: SessionId): void {
    this.sessions.delete(sessionId)
  }

  private load(sessionId: SessionId): Map<FileUploadReceiptId, StagedFileUpload> {
    const cached = this.sessions.get(sessionId)
    if (cached !== undefined) return cached
    const staged = new Map<FileUploadReceiptId, StagedFileUpload>()
    this.sessions.set(sessionId, staged)
    let text: string
    try {
      text = readFileSync(fileFor(this.root, sessionId), 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return staged
      this.warn(`file-upload: receipt cache for "${sessionId}" could not be read: ${String(error)}`)
      return staged
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.warn(`file-upload: receipt cache for "${sessionId}" is not JSON`)
      return staged
    }
    if (!isDocument(parsed, sessionId)) {
      this.warn(`file-upload: receipt cache for "${sessionId}" has an unexpected shape`)
      return staged
    }
    const now = Date.now()
    let pruned = false
    for (const [receiptId, entry] of Object.entries(parsed.receipts)) {
      if (entry.createdAt !== undefined && now - entry.createdAt > RECEIPT_TTL_MS) {
        pruned = true
        continue
      }
      staged.set(receiptId as FileUploadReceiptId, {
        file: entry.file,
        ...entry.requestId === undefined ? {} : { requestId: entry.requestId },
        ...entry.createdAt === undefined ? {} : { createdAt: entry.createdAt },
      })
    }
    if (pruned) {
      // Best effort: a failed cleanup keeps the in-memory view correct and
      // retries on the next load.
      try {
        this.persist(sessionId)
      } catch (error) {
        this.warn(`file-upload: expired receipts for "${sessionId}" could not be pruned: ${String(error)}`)
      }
    }
    return staged
  }

  private persist(sessionId: SessionId): void {
    const staged = this.sessions.get(sessionId)
    const path = fileFor(this.root, sessionId)
    if (staged === undefined || staged.size === 0) {
      this.sessions.delete(sessionId)
      try {
        unlinkSync(path)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      return
    }
    const receipts: Record<string, { file: FileAttachmentRef; requestId?: string; createdAt?: number }> = {}
    for (const [receiptId, upload] of staged) {
      receipts[receiptId] = {
        file: upload.file,
        ...upload.requestId === undefined ? {} : { requestId: upload.requestId },
        ...upload.createdAt === undefined ? {} : { createdAt: upload.createdAt },
      }
    }
    const document: ReceiptDocument = { version: DOCUMENT_VERSION, sessionId, receipts }
    // A private directory keeps other local accounts from reading receipts;
    // rename is atomic within one filesystem, so a reader never sees a prefix.
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  }
}

function isDocument(value: unknown, sessionId: SessionId): value is ReceiptDocument {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record['version'] !== DOCUMENT_VERSION || record['sessionId'] !== sessionId) return false
  const receipts = record['receipts']
  if (typeof receipts !== 'object' || receipts === null || Array.isArray(receipts)) return false
  return Object.values(receipts).every(isReceipt)
}

function isReceipt(value: unknown): value is { readonly file: FileAttachmentRef; readonly requestId?: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const file = record['file']
  if (typeof file !== 'object' || file === null) return false
  const ref = file as Record<string, unknown>
  return typeof ref['attachmentId'] === 'string'
    && typeof ref['name'] === 'string'
    && typeof ref['bytes'] === 'number'
    && (record['requestId'] === undefined || typeof record['requestId'] === 'string')
    && (record['createdAt'] === undefined || typeof record['createdAt'] === 'number')
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

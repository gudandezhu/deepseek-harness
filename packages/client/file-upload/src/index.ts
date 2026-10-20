/** Host file-upload service: streamed intake and Session-owned staged receipts. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CommandFileReceiptResolver } from '@deepseek-ai/dsh-commands'
import { dshCachePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { handleFileUploadHttp } from './http-route.ts'
import { FILE_UPLOAD_PATH } from './protocol.ts'
import { StagedReceiptStore } from './receipt-store.ts'
import type { EncodedFileUploadRequest, FileUploadReceiptId, FileUploadValue } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host storage and staged-receipt service for browser file uploads. */
    fileUploads: FileUploads
  }
}

/** File-upload deployment policy. */
export interface Config {
  /**
   * Directory holding one private receipt document per Session. Defaults to
   * `$DSH_HOME/cache/file-upload-receipts`; tests point it at a temporary root.
   */
  readonly receiptRoot?: string
}

/** Prompt receipt binding that restores its previous owners unless delivery commits it. */
export interface PromptFileBinding extends Disposable {
  /** Keep the receipt bindings until queue or history observation retires them. */
  commit(): void
}

class PromptFileBindingGuard implements PromptFileBinding {
  private settled = false

  constructor(private readonly rollback: () => void) {}

  commit(): void {
    this.settled = true
  }

  [Symbol.dispose](): void {
    if (this.settled) return
    this.settled = true
    this.rollback()
  }
}

/**
 * Host service owning upload storage and staged receipts. Receipts are keyed
 * by Session identity and persisted under the Harness cache, so a worker that
 * exits between upload and prompt does not take its receipts with it.
 */
export class FileUploads extends TypertRemoteService {
  static inject = ['agents', 'attachments', 'commands', 'connection']

  private readonly receipts: StagedReceiptStore

  /**
   * @param ctx - Host context carrying Agent, attachment, command, and Connection services.
   * @param config - receipt-cache root override.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'fileUploads')
    this.receipts = new StagedReceiptStore(
      config.receiptRoot ?? dshCachePath('file-upload-receipts'),
      (message) => { ctx.logger.warn(message) },
    )
    const resolve: CommandFileReceiptResolver = (agent, receiptId) =>
      this.resolve(agent, receiptId as FileUploadReceiptId)
    ctx.effect(
      () => ctx.commands.registerFileReceiptResolver(resolve),
      'file-upload: command file receipt resolver',
    )
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: FILE_UPLOAD_PATH,
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: request => handleFileUploadHttp(this, request),
      }),
      'file-upload: streaming route',
    )
    ctx.on('session/event', (session, event) => { this.observeSessionEvent(session, event) })
    // Receipts survive Session disposal: the worker that owned the Agent is
    // exiting, and its successor resolves the same durable document. Only the
    // hot copy is dropped here.
    ctx.on('session/disposed', (session) => { this.receipts.forget(session.id) })
  }

  /**
   * Persist one encoded upload and stage it under the Agent receiver selected by Typert.
   * @param agent - receiving Agent resolved from the Remote Agent scope.
   * @param request - canonical base64 bytes and optional display name.
   * @param signal - caller cancellation before storage begins.
   * @returns the staged receipt and durable file reference.
   */
  @Remote('upload')
  async upload(agent: Agent, request: EncodedFileUploadRequest, signal: AbortSignal): Promise<FileUploadValue> {
    signal.throwIfAborted()
    this.assertOrdinaryAgent(agent)
    return this.commit(agent.session.id, async () => this.ctx.attachments.admitEncodedFile({
      data: request.data,
      ...(request.name === undefined ? {} : { name: request.name }),
    }), () => {
      if (this.ctx.agents.get(agent.id) !== agent) {
        throw new RemoteError(
          'session/not-found',
          `session "${agent.id}" was disposed before its file upload completed`,
          { sessionId: agent.id },
        )
      }
    })
  }

  /**
   * Persist raw chunks for one Session without aggregating the upload and
   * without activating its Agent. In a worker deployment the Host receives
   * this browser upload while the Agent lives in another process; the receipt
   * document is what the owning worker later reads.
   * @param request - Session identity, ordered bytes, cancellation, and optional display name.
   * @returns the staged receipt and durable file reference.
   */
  async uploadStream(request: {
    readonly sessionId: SessionId
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<FileUploadValue> {
    return this.commit(request.sessionId, () => this.ctx.attachments.saveFileStream({
      data: request.data,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.name === undefined ? {} : { name: request.name }),
    }))
  }

  /**
   * Resolve one staged receipt for the receiving Agent's exact Session.
   * @param agent - receiving Agent.
   * @param receiptId - opaque receipt minted for one completed upload.
   * @returns durable file reference, or `undefined` for an unknown or foreign receipt.
   */
  resolve(agent: Agent, receiptId: FileUploadReceiptId): FileAttachmentRef | undefined {
    return this.receipts.get(agent.session.id, receiptId)
  }

  /**
   * Bind receipts while one prompt enters an Agent inbox.
   * Disposal restores every prior binding unless the caller commits successful delivery.
   * @param agent - receiving Agent.
   * @param receiptIds - distinct staged receipts referenced by the prompt.
   * @param requestId - prompt identity later observed in queue or history.
   * @returns binding kept after commit until queue or history observation retires its receipts.
   */
  bindPrompt(
    agent: Agent,
    receiptIds: readonly FileUploadReceiptId[],
    requestId: string,
  ): PromptFileBinding {
    const bound = this.receipts.bind(agent.session.id, receiptIds, requestId)
    if (bound === undefined) throw fileNotStaged()
    return new PromptFileBindingGuard(() => {
      this.receipts.restore(agent.session.id, bound)
    })
  }

  /**
   * Retire every receipt accepted by one removed queue occurrence.
   * @param agent - receiving Agent.
   * @param requestId - prompt identity carried by the queue occurrence.
   */
  retirePrompt(agent: Agent, requestId: string): void {
    this.retire(agent.session, requestId)
  }

  private async commit(
    sessionId: SessionId,
    save: () => Promise<FileAttachmentRef>,
    check?: () => void,
  ): Promise<FileUploadValue> {
    let file: FileAttachmentRef
    try {
      file = await save()
    } catch (error) {
      if (this.ctx.attachments.isAttachmentError(error)) {
        throw new RemoteError('session/attachment-invalid' as never, error.message, { reason: error.code } as never)
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to store file upload: ${String(error)}`,
        {},
        { cause: error },
      )
    }
    check?.()
    const receiptId = randomUUID() as FileUploadReceiptId
    try {
      this.receipts.put(sessionId, receiptId, { file })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to stage file upload receipt: ${String(error)}`,
        {},
        { cause: error },
      )
    }
    return { receiptId, file }
  }

  private assertOrdinaryAgent(agent: Agent): void {
    if (agent.session.header.origin === 'subagent') {
      throw new RemoteError(
        'subagent/attachment-invalid' as never,
        'subagent conversations do not accept file uploads',
        { reason: 'SUBAGENT_FILE_UNSUPPORTED' } as never,
      )
    }
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user'
      || !('rpcId' in event.data.source)) return
    if (typeof event.data.source.rpcId === 'string') this.retire(session, event.data.source.rpcId)
  }

  private retire(session: Session, requestId: string): void {
    this.receipts.retire(session.id, requestId)
  }
}

function fileNotStaged(): RemoteError {
  return new RemoteError(
    'session/attachment-invalid' as never,
    'File was not uploaded for this session.',
    { reason: 'FILE_NOT_STAGED' } as never,
  )
}

export default FileUploads

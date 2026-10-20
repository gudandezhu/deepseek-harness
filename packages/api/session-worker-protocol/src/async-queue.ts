/**
 * Single-consumer async queue shared by both halves of the session-worker
 * control channel: the host's downlink iterator and the worker's mux uplink.
 * Bounded so a peer that stops reading fails the stream instead of growing the
 * process without limit.
 *
 * @module @deepseek-ai/dsh-session-worker-protocol/async-queue
 */

/** Failure raised when a producer outruns the configured queue bound. */
export class AsyncQueueOverflowError extends Error {
  /** Stable diagnostic code for protocol-level overflow. */
  readonly code = 'session-worker/queue-overflow'

  /**
   * @param limit - maximum number of buffered values.
   */
  constructor(limit: number) {
    super(`session-worker: async queue exceeded ${String(limit)} buffered values`)
    this.name = 'AsyncQueueOverflowError'
  }
}

/**
 * One buffered value queue that preserves production order and terminates
 * exactly once with either end-of-input or a failure.
 * @typeParam T - value carried by the queue.
 */
export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: PromiseWithResolvers<IteratorResult<T>>[] = []
  private finished = false
  private failure: unknown

  /**
   * @param maxValues - positive bound on buffered values.
   */
  constructor(private readonly maxValues: number) {
    if (!Number.isSafeInteger(maxValues) || maxValues < 1) {
      throw new RangeError(`session-worker: queue bound must be a positive integer, got ${JSON.stringify(maxValues)}`)
    }
  }

  /**
   * Append one value, delivering it immediately to a waiting consumer.
   * @param value - value to append.
   * @throws {AsyncQueueOverflowError} when no consumer has drained the bound.
   */
  push(value: T): void {
    if (this.finished) throw new Error('session-worker: cannot push after the queue finished')
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value })
      return
    }
    if (this.values.length >= this.maxValues) throw new AsyncQueueOverflowError(this.maxValues)
    this.values.push(value)
  }

  /** Stop accepting values and wake every pending read with end-of-input. */
  end(): void {
    if (this.finished) return
    this.finished = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined })
    }
  }

  /**
   * Terminate with a failure; pending and later reads reject with it.
   * @param reason - caller-owned failure value.
   */
  fail(reason: unknown): void {
    if (this.finished) return
    this.finished = true
    this.failure = reason
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason)
  }

  /** @returns the next value, end-of-input, or the recorded failure. */
  next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      // Read by length so a stored `undefined` is still a delivered value.
      return Promise.resolve({ done: false, value: this.values.shift() as T })
    }
    if (this.finished) {
      if (this.failure !== undefined) {
        const reason = this.failure
        return Promise.reject(reason instanceof Error
          ? reason
          : new Error(typeof reason === 'string' ? reason : 'session-worker: queue failed'))
      }
      return Promise.resolve({ done: true, value: undefined })
    }
    const waiter = Promise.withResolvers<IteratorResult<T>>()
    this.waiters.push(waiter)
    return waiter.promise
  }

  /**
   * End the queue and release its consumer.
   * @returns a completed iterator result.
   */
  return(): Promise<IteratorResult<T>> {
    this.end()
    return Promise.resolve({ done: true, value: undefined })
  }

  /** @returns this queue as its own single-consumer iterator. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

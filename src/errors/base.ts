/**
 * Root error class for every misina-thrown failure (`HTTPError`,
 * `NetworkError`, `TimeoutError`, `ResponseTooLargeError`, `CircuitOpenError`,
 * `DigestMismatchError`, `SchemaValidationError`, `GraphqlAggregateError`,
 * `PollExhaustedError`). Use `instanceof MisinaError` to discriminate
 * misina failures from arbitrary thrown values, and the more specific
 * subclasses to discriminate by failure mode.
 *
 * @example
 * ```ts
 * import { MisinaError, isHTTPError, isTimeoutError } from "misina"
 *
 * try {
 *   await api.get("/users/42")
 * } catch (err) {
 *   if (isHTTPError(err)) console.warn("HTTP", err.status)
 *   else if (isTimeoutError(err)) console.warn("slow upstream")
 *   else if (err instanceof MisinaError) console.warn("misina:", err.message)
 *   else throw err
 * }
 * ```
 */
export class MisinaError extends Error {
  override readonly name: string = "MisinaError"

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined)

    // V8-only API — present in Node, Bun, Cloudflare Workers, Deno.
    // Absent in Safari/Firefox; the conditional is the lowest-cost
    // way to keep cross-runtime stacks clean without a build flag.
    if (typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === "function") {
      ;(Error as { captureStackTrace: (target: object, ctor: Function) => void }).captureStackTrace(
        this,
        new.target,
      )
    }
  }

  /**
   * Structured serialization — pino / winston / bunyan / @std/log all call
   * this. Returns a plain object safe for `JSON.stringify`. Includes the
   * `cause` chain when present.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      stack: this.stack,
      cause: serializeCause(this.cause),
    }
  }
}

function serializeCause(cause: unknown): unknown {
  if (cause == null) return undefined
  if (cause instanceof MisinaError) return cause.toJSON()
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack }
  }
  return cause
}

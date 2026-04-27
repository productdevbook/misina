import { MisinaError } from "./base.ts"

/**
 * Thrown when the per-attempt `timeout`, `bodyTimeout`, or `totalTimeout`
 * deadline elapses. `.timeout` carries the configured budget in
 * milliseconds; `.cause` carries the underlying `AbortSignal.timeout`
 * abort reason.
 *
 * @example
 * ```ts
 * import { isTimeoutError } from "misina"
 *
 * try {
 *   await api.get("/slow", { timeout: 1500 })
 * } catch (err) {
 *   if (isTimeoutError(err)) console.warn(`upstream took >${err.timeout}ms`)
 *   else throw err
 * }
 * ```
 */
export class TimeoutError extends MisinaError {
  override readonly name = "TimeoutError"
  readonly timeout: number

  constructor(timeout: number, options?: { cause?: unknown }) {
    super(`Request timed out after ${timeout}ms`, options)
    this.timeout = timeout
  }
}

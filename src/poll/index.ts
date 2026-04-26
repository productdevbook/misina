import { delayMs } from "../_retry.ts"
import { composeSignals, timeoutSignal } from "../_signal.ts"
import type { Misina, MisinaRequestInit } from "../types.ts"

export interface PollOptions<T> {
  /**
   * Predicate run on each polled response. Return `true` to resolve with the
   * current data; `false` to keep polling.
   */
  until: (data: T) => boolean | Promise<boolean>
  /** Delay between attempts in ms. Default: 1000. */
  interval?: number | ((attempt: number) => number)
  /** Total wall-clock deadline in ms. Throws TimeoutError if exceeded. */
  timeout?: number
  /** Cap on number of poll attempts. Default: Infinity. */
  maxAttempts?: number
  /** External abort signal — composes with the timeout. */
  signal?: AbortSignal
  /** Per-request init forwarded to misina (headers, query, etc). */
  init?: MisinaRequestInit
}

export class PollExhaustedError extends Error {
  override readonly name = "PollExhaustedError"
  constructor(public readonly attempts: number) {
    super(`Polling exhausted after ${attempts} attempts without satisfying \`until\``)
  }
}

/**
 * Poll a URL until `until(data)` returns true. Resolves with the matching
 * `data`. Throws on timeout, abort, or attempt exhaustion.
 *
 * ```ts
 * const job = await poll<JobStatus>(misina, "/jobs/42", {
 *   interval: 1000,
 *   timeout: 60_000,
 *   until: (j) => j.state === "done",
 * })
 * ```
 */
export async function poll<T = unknown>(
  misina: Misina,
  url: string,
  options: PollOptions<T>,
): Promise<T> {
  const intervalFn =
    typeof options.interval === "function"
      ? options.interval
      : (): number => (options.interval as number) ?? 1000
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY

  const signals: (AbortSignal | undefined)[] = [options.signal]
  if (options.timeout) signals.push(timeoutSignal(options.timeout))
  const composed = composeSignals(signals)

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (composed?.aborted) throw composed.reason ?? new DOMException("aborted", "AbortError")

    const res = await misina.get<T>(url, {
      ...options.init,
      signal: composed,
    })
    const done = await options.until(res.data)
    if (done) return res.data

    if (attempt + 1 >= maxAttempts) break

    const wait = intervalFn(attempt + 1)
    if (wait > 0) await delayMs(wait, composed)
  }

  throw new PollExhaustedError(maxAttempts)
}

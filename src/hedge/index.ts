/**
 * Hedged requests — fire the same call to multiple endpoints, accept
 * the first successful response, abort the rest. Reduces P99 latency
 * dramatically (Google's "tail at scale": typical 75-96% drop) at a
 * 5-10% extra cost.
 *
 * @example
 * ```ts
 * import { hedge } from "misina/hedge"
 *
 * const data = await hedge(misina, "/inference", {
 *   endpoints: [
 *     "https://us-east.api.example.com",
 *     "https://us-west.api.example.com",
 *   ],
 *   delayMs: 200,                // wait 200ms before firing the second
 *   max: 2,                      // cap parallel attempts
 * })
 * ```
 */

import type { Misina, MisinaRequestInit } from "../types.ts"

export interface HedgeOptions {
  /**
   * Endpoint base URLs. Each request is dispatched against
   * `endpoint + path`. Order matters — earlier endpoints fire first.
   */
  endpoints: string[]
  /**
   * Delay in ms between firing the next endpoint. Default: 0
   * (all endpoints fire immediately in parallel).
   */
  delayMs?: number
  /** Cap on concurrent attempts. Default: endpoints.length. */
  max?: number
  /** Per-call init forwarded to misina. */
  init?: MisinaRequestInit
  /** External AbortSignal — cancels all in-flight attempts. */
  signal?: AbortSignal
}

/**
 * Race a request across endpoints; first successful response wins.
 * Aborts all losing in-flight attempts. If every endpoint errors, the
 * first error is rethrown (others surface on `error.cause` array).
 *
 * @returns the data from the winning response.
 */
export async function hedge<T = unknown>(
  misina: Misina,
  path: string,
  options: HedgeOptions,
): Promise<T> {
  const endpoints = options.endpoints.slice(0, options.max ?? options.endpoints.length)
  if (endpoints.length === 0) throw new Error("misina/hedge: endpoints array is empty")

  const losers: AbortController[] = []
  const errors: unknown[] = []
  let settled = false

  const dispatchAt = (i: number, ac: AbortController): Promise<T> =>
    misina
      .get<T>(joinUrl(endpoints[i]!, path), {
        ...options.init,
        signal: composeOptional(options.signal, ac.signal),
      })
      .then((res) => {
        if (settled) throw new HedgeLoserError("not-the-winner")
        settled = true
        for (const other of losers) {
          if (other !== ac) other.abort(new HedgeLoserError("hedge-loser"))
        }
        return res.data
      })

  const launch = async (): Promise<T> => {
    const winners: Promise<T>[] = []
    for (let i = 0; i < endpoints.length; i++) {
      const ac = new AbortController()
      losers.push(ac)
      const p = dispatchAt(i, ac).catch((err) => {
        errors[i] = err
        throw err
      })
      winners.push(p)
      if (i < endpoints.length - 1 && options.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs)
          if (options.signal) {
            options.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer)
                reject(options.signal!.reason)
              },
              { once: true },
            )
          }
        })
        // If something already settled while we were waiting, stop firing.
        if (settled) break
      }
    }
    return Promise.any(winners).catch((aggregate: AggregateError) => {
      // Promise.any throws AggregateError when all reject. Surface the
      // first non-loser error as the primary; collect the rest on cause.
      const nonLoser = aggregate.errors.find((e) => !(e instanceof HedgeLoserError))
      const primary = nonLoser ?? aggregate.errors[0]
      if (primary instanceof Error) {
        ;(primary as Error & { cause?: unknown }).cause ??= aggregate
      }
      throw primary
    })
  }

  return launch()
}

export class HedgeLoserError extends Error {
  override readonly name = "HedgeLoserError"
  constructor(reason: string) {
    super(reason)
  }
}

function joinUrl(base: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path
  if (base.endsWith("/") && path.startsWith("/")) return base + path.slice(1)
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`
  return base + path
}

function composeOptional(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b
  if (!b) return a
  return AbortSignal.any([a, b])
}

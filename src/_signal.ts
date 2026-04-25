/**
 * Compose multiple AbortSignals into one. Aborts when any source aborts.
 *
 * Uses native `AbortSignal.any` — Node ≥ 22, Bun ≥ 1.2, Deno ≥ 2.0,
 * Baseline 2024 browsers (Safari 17.4, Chrome 116, Firefox 124).
 */
export function composeSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => Boolean(s))
  if (real.length === 0) return undefined
  if (real.length === 1) return real[0]
  return AbortSignal.any(real)
}

/**
 * Build a timeout signal using native `AbortSignal.timeout`. Reason is a
 * `TimeoutError`-style DOMException — used by `isOurTimeoutAbort` to tell
 * "our timer fired" from "user aborted".
 */
export function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

/**
 * True when the signal aborted because *we* set a timeout (not the user).
 */
export function isOurTimeoutAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false
  const reason = signal.reason as { name?: string } | undefined
  return reason?.name === "TimeoutError"
}

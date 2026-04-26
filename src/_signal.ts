/**
 * Compose multiple AbortSignals into one. Aborts when any source aborts.
 *
 * Manual implementation — `AbortSignal.any` keeps strong references to the
 * source signals on each composed signal (Node #57736), which leaks listeners
 * when the source signals outlive individual requests (e.g. one app-wide
 * AbortSignal shared across thousands of fetches). We attach `{ once: true }`
 * listeners and detach them after the first source aborts or when the
 * returned signal's controller is GC'd alongside the request.
 */
export function composeSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => Boolean(s))
  if (real.length === 0) return undefined
  if (real.length === 1) return real[0]
  for (const s of real) {
    if (s.aborted) {
      const c = new AbortController()
      c.abort(s.reason)
      return c.signal
    }
  }
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  const onAbort = (event: Event): void => {
    const source = event.target as AbortSignal
    for (const off of cleanups) off()
    cleanups.length = 0
    controller.abort(source.reason)
  }
  for (const s of real) {
    s.addEventListener("abort", onAbort, { once: true })
    cleanups.push(() => s.removeEventListener("abort", onAbort))
  }
  return controller.signal
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

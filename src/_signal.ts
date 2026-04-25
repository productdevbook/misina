/**
 * Compose multiple AbortSignals into one. Aborts when any source aborts.
 *
 * Uses native `AbortSignal.any` (Node 20.5+, Bun, Deno, modern browsers)
 * with a small fallback for environments that haven't shipped it yet.
 */
export function composeSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => Boolean(s))
  if (real.length === 0) return undefined
  if (real.length === 1) return real[0]

  const anyImpl = (AbortSignal as unknown as { any?: (sigs: AbortSignal[]) => AbortSignal }).any
  if (typeof anyImpl === "function") return anyImpl(real)

  const controller = new AbortController()
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener(
      "abort",
      () => {
        controller.abort(signal.reason)
      },
      { once: true },
    )
  }
  return controller.signal
}

/**
 * Build a timeout signal using `AbortSignal.timeout` when available, with
 * a fallback for older runtimes. Reason is a `TimeoutError`-style DOMException.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const timeoutImpl = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof timeoutImpl === "function") return timeoutImpl(ms)

  const controller = new AbortController()
  setTimeout(() => {
    controller.abort(new DOMException(`Timeout of ${ms}ms exceeded`, "TimeoutError"))
  }, ms)
  return controller.signal
}

/**
 * True when the signal aborted because *we* set a timeout (not the user).
 */
export function isOurTimeoutAbort(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false
  const reason = signal.reason as { name?: string } | undefined
  return reason?.name === "TimeoutError"
}

import { MisinaError } from "../errors/base.ts"
import type { Misina, MisinaContext, MisinaRequestInit, MisinaResponsePromise } from "../types.ts"
import { catchable } from "../_catch.ts"

/**
 * Circuit-breaker policy. The breaker wraps a Misina instance and tracks
 * recent failures; once a threshold is crossed, subsequent requests fail
 * fast with a `CircuitOpenError` until a probe (`halfOpenAfter` ms later)
 * is allowed through to test recovery.
 *
 * State machine (Polly / cockatiel shape):
 *
 *   closed ──[N consecutive failures within `windowMs`]──▶ open
 *   open   ──[wait `halfOpenAfter` ms]────────────────────▶ half-open
 *   half-open ──[probe succeeds]───────────────────────▶ closed
 *   half-open ──[probe fails]──────────────────────────▶ open (reset timer)
 */
export interface CircuitBreakerOptions {
  /** Trip the breaker after this many failures inside `windowMs`. Default: 5. */
  failureThreshold?: number
  /** Sliding window for failure counting (ms). Default: 30_000. */
  windowMs?: number
  /** How long to stay open before allowing a probe. Default: 10_000. */
  halfOpenAfter?: number
  /**
   * Decide whether a settled call counts as a failure. Default: any thrown
   * error, or any 5xx HTTPError.
   */
  isFailure?: (ctx: BreakerCallResult) => boolean
}

export interface BreakerCallResult {
  /** The error if the call rejected, undefined on success. */
  error: Error | undefined
  /** The Misina context for this call (request/response/options). */
  ctx: MisinaContext
}

export type BreakerState = "closed" | "open" | "half-open"

export interface BreakerHandle {
  state: () => BreakerState
  /** Force the breaker open (e.g. external monitoring trip). */
  trip: () => void
  /** Force back to closed (e.g. manual recovery). */
  reset: () => void
}

export class CircuitOpenError extends MisinaError {
  override readonly name = "CircuitOpenError"
  /** ms until the breaker will allow a probe. */
  readonly retryAfter: number
  constructor(retryAfter: number) {
    super(`Circuit is open — failing fast (try again in ${retryAfter}ms)`)
    this.retryAfter = retryAfter
  }
}

const DEFAULT_OPTS = {
  failureThreshold: 5,
  windowMs: 30_000,
  halfOpenAfter: 10_000,
}

function defaultIsFailure({ error }: BreakerCallResult): boolean {
  if (!error) return false
  // 5xx HTTPError counts; 4xx (client mistake) does not.
  const status = (error as { status?: number }).status
  if (typeof status === "number") return status >= 500
  return true
}

/**
 * Wrap a Misina with a circuit breaker.
 *
 * ```ts
 * const api = withCircuitBreaker(misina, { failureThreshold: 3 })
 * ```
 *
 * Returns the wrapped misina; the breaker handle for inspection/control is
 * available via the `.breaker` extension on the returned object.
 */
export function withCircuitBreaker(
  misina: Misina,
  opts: CircuitBreakerOptions = {},
): Misina & { breaker: BreakerHandle } {
  const failureThreshold = opts.failureThreshold ?? DEFAULT_OPTS.failureThreshold
  const windowMs = opts.windowMs ?? DEFAULT_OPTS.windowMs
  const halfOpenAfter = opts.halfOpenAfter ?? DEFAULT_OPTS.halfOpenAfter
  const isFailure = opts.isFailure ?? defaultIsFailure

  let state: BreakerState = "closed"
  let openedAt = 0
  // Sliding-window failure timestamps.
  let failures: number[] = []

  function pruneWindow(now: number): void {
    const cutoff = now - windowMs
    if (failures.length === 0) return
    if (failures[0]! >= cutoff) return
    failures = failures.filter((t) => t >= cutoff)
  }

  function transitionToOpen(now: number): void {
    state = "open"
    openedAt = now
  }

  function recordSuccess(): void {
    failures = []
    state = "closed"
    openedAt = 0
  }

  function recordFailure(now: number): void {
    if (state === "half-open") {
      // Probe failed — back to open with a fresh timer.
      transitionToOpen(now)
      return
    }
    failures.push(now)
    pruneWindow(now)
    if (failures.length >= failureThreshold) {
      transitionToOpen(now)
    }
  }

  function admit(now: number): void {
    if (state === "closed") return
    if (state === "open") {
      if (now - openedAt < halfOpenAfter) {
        throw new CircuitOpenError(halfOpenAfter - (now - openedAt))
      }
      // Time elapsed — let one probe through.
      state = "half-open"
      return
    }
    // half-open: only one probe is allowed at a time. The simplest
    // bookkeeping is to flip back to open while the probe is in flight,
    // so concurrent calls fail fast and the next probe is scheduled
    // exactly halfOpenAfter from now. Once the probe settles we either
    // close (success) or stay open (failure).
    transitionToOpen(now)
  }

  function wrap<T>(underlying: () => MisinaResponsePromise<T>): MisinaResponsePromise<T> {
    const promise = (async (): Promise<T> => {
      const now = Date.now()
      admit(now)

      try {
        const res = await underlying()
        recordSuccess()
        return res as unknown as T
      } catch (e) {
        const error = e as Error
        if (
          isFailure({
            error,
            ctx: ((error as { ctx?: MisinaContext }).ctx ?? {}) as MisinaContext,
          })
        ) {
          recordFailure(Date.now())
        } else {
          // Non-counted failure (e.g. 4xx) — don't trip the breaker, but if
          // we were probing in half-open, treat it as success-ish (the
          // service is reachable). Be conservative: just don't add to fails.
          if (state === "half-open") recordSuccess()
        }
        throw error
      }
    })()

    return catchable(promise) as MisinaResponsePromise<T>
  }

  const breaker: BreakerHandle = {
    state: () => state,
    trip: () => transitionToOpen(Date.now()),
    reset: () => recordSuccess(),
  }

  return {
    ...misina,
    breaker,
    request: <T = unknown>(input: string, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.request<T>(input, init)),
    get: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.get<T>(url, init)),
    head: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.head<T>(url, init)),
    options: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.options<T>(url, init)),
    delete: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.delete<T>(url, init)),
    post: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.post<T>(url, body, init)),
    put: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.put<T>(url, body, init)),
    patch: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      wrap<T>(() => misina.patch<T>(url, body, init)),
  }
}

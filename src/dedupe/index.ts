import type {
  HttpMethod,
  Misina,
  MisinaRequestInit,
  MisinaResponse,
  MisinaResponsePromise,
} from "../types.ts"

const DEFAULT_METHODS: HttpMethod[] = ["GET", "HEAD", "OPTIONS"]

export interface DedupeOptions {
  /** Compute a dedupe key. Default: `${method} ${url}`. */
  key?: (input: string, init?: MisinaRequestInit) => string
  /** Methods eligible for de-duplication. Default: GET/HEAD/OPTIONS. */
  methods?: HttpMethod[]
}

/**
 * Wrap a Misina so concurrent identical requests share a single in-flight
 * promise. Each waiter receives the same Response (cloned per access of
 * `.raw`).
 *
 * Defaults to safe methods only — de-duping POST is risky.
 */
export function withDedupe(misina: Misina, opts: DedupeOptions = {}): Misina {
  const methods = opts.methods ?? DEFAULT_METHODS
  const computeKey =
    opts.key ?? ((input, init) => `${(init?.method ?? "GET").toUpperCase()} ${input}`)
  const inflight = new Map<string, Promise<MisinaResponse<unknown>>>()

  function dedupedRequest<T>(input: string, init?: MisinaRequestInit): MisinaResponsePromise<T> {
    const method = (init?.method ?? "GET").toUpperCase() as HttpMethod
    if (!methods.includes(method)) return misina.request<T>(input, init)

    const key = computeKey(input, init)
    const existing = inflight.get(key)
    if (existing) return cloneResponsePromise<T>(existing)

    const promise = misina.request<T>(input, init).finally(() => {
      // Hold the slot for the current microtask tick so synchronous concurrent
      // callers all collapse onto this promise. Then free it for future calls.
      queueMicrotask(() => inflight.delete(key))
    })
    inflight.set(key, promise as Promise<MisinaResponse<unknown>>)
    return promise as MisinaResponsePromise<T>
  }

  // Re-bind every shorthand to the deduped request to avoid drift.
  return {
    ...misina,
    request: <T = unknown>(input: string, init?: MisinaRequestInit) =>
      dedupedRequest<T>(input, init),
    get: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "GET" }),
    head: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "HEAD" }),
    options: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "OPTIONS" }),
    // Mutating methods stay un-deduped — even if user enables them via the
    // `methods` option, dedupe never bypasses misina's normal request path.
  }
}

function cloneResponsePromise<T>(
  shared: Promise<MisinaResponse<unknown>>,
): MisinaResponsePromise<T> {
  const clone = shared.then((res) => ({
    ...res,
    raw: res.raw.clone(),
  })) as MisinaResponsePromise<T>
  // onError stub — defer to underlying once awaited
  clone.onError = function (matcher, handler) {
    return clone.then(
      (v) => v,
      (e) => {
        if (matchesError(matcher, e)) return handler(e as Error)
        throw e
      },
    ) as MisinaResponsePromise<T>
  }
  return clone
}

function matchesError(matcher: unknown, error: unknown): boolean {
  if (typeof matcher === "function") return (matcher as (e: unknown) => boolean)(error)
  if (typeof matcher === "string") {
    return error instanceof Error && error.name === matcher
  }
  if (typeof matcher === "number") {
    return (
      error instanceof Error &&
      "status" in error &&
      (error as { status: number }).status === matcher
    )
  }
  if (Array.isArray(matcher)) {
    return (
      error instanceof Error &&
      "status" in error &&
      matcher.includes((error as { status: number }).status)
    )
  }
  return false
}

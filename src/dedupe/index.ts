import { catchable } from "../_catch.ts"
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
 * promise. Each waiter receives the same body (response.raw is cloned per
 * waiter so each can read it independently).
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
    if (existing) {
      // Each waiter gets the same MisinaResponse — `data` is already parsed
      // (immutable from the user's POV), `raw` is shared. If a waiter needs
      // to re-read the body via `.raw.text()` etc, they should clone it
      // themselves before consuming.
      return catchable(existing.then((res) => res as MisinaResponse<T>)) as MisinaResponsePromise<T>
    }

    const underlying = misina.request<T>(input, init)
    // Track without disturbing the user-facing promise: a separate `.then`
    // chain feeds the inflight Map; the user keeps the original catchable.
    const tracked = underlying.then((res) => res as MisinaResponse<unknown>)
    // Both inner branches need a `.catch` so an unhandled-rejection warning
    // doesn't fire when only `underlying` is awaited by the caller.
    tracked.catch(() => {})
    underlying
      .finally(() => {
        // Free the slot the moment the underlying request settles. Concurrent
        // callers that bind `existing` _before_ the request settles share the
        // same promise; once it settles, sequential callers (after `await`)
        // get a fresh request — which is what users expect.
        inflight.delete(key)
      })
      .catch(() => {})
    inflight.set(key, tracked)
    return underlying
  }

  // Re-bind every shorthand to the deduped request — including mutating
  // methods, since `methods` may opt POST/PUT/PATCH/DELETE in. Non-listed
  // methods short-circuit inside `dedupedRequest` to the underlying call.
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
    delete: <T = unknown>(url: string, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "DELETE" }),
    post: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "POST", body }),
    put: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "PUT", body }),
    patch: <T = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      dedupedRequest<T>(url, { ...init, method: "PATCH", body }),
  }
}

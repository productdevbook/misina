import { catchable } from "../_catch.ts"
import type {
  HttpMethod,
  MisinaPlugin,
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
 * Plugin that collapses concurrent identical requests onto a single
 * in-flight promise. Each waiter receives the same `MisinaResponse` —
 * `response.raw` is shared, so callers wanting to re-read the body via
 * `.raw.text()` should clone it first.
 *
 * Defaults to safe methods only — de-duping POST is risky.
 */
export function dedupe(opts: DedupeOptions = {}): MisinaPlugin {
  const methods = opts.methods ?? DEFAULT_METHODS
  const computeKey =
    opts.key ?? ((input, init) => `${(init?.method ?? "GET").toUpperCase()} ${input}`)
  const inflight = new Map<string, Promise<MisinaResponse<unknown>>>()

  return {
    name: "dedupe",
    extend: (misina) => {
      function dedupedRequest<T>(
        input: string,
        init?: MisinaRequestInit,
      ): MisinaResponsePromise<T> {
        const method = (init?.method ?? "GET").toUpperCase() as HttpMethod
        if (!methods.includes(method)) return misina.request<T>(input, init)

        const key = computeKey(input, init)
        const existing = inflight.get(key)
        if (existing) {
          return catchable(
            existing.then((res) => res as MisinaResponse<T>),
          ) as MisinaResponsePromise<T>
        }

        const underlying = misina.request<T>(input, init)
        const tracked = underlying.then((res) => res as MisinaResponse<unknown>)
        tracked.catch(() => {})
        underlying
          .finally(() => {
            inflight.delete(key)
          })
          .catch(() => {})
        inflight.set(key, tracked)
        return underlying
      }

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
    },
  }
}

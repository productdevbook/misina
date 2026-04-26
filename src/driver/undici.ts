/**
 * Undici-backed driver — gives Node callers full control over the
 * connection pool, keep-alive, pipelining, and HTTP/2 negotiation that
 * the runtime's built-in fetch hides behind a default `Agent`.
 *
 * Peer dependency: `undici`. The package is **not** bundled — the
 * driver dynamically imports `undici` the first time `request()` is
 * called, so misina's other entry points stay zero-dep. Make sure
 * `undici` is in your project's `dependencies` (any 6.x or newer).
 *
 * @example
 * ```ts
 * import { Agent } from "undici"
 * import { undiciDriver } from "misina/driver/undici"
 *
 * const api = createMisina({
 *   driver: undiciDriver({
 *     dispatcher: new Agent({
 *       connections: 100,
 *       keepAliveTimeout: 30_000,
 *       pipelining: 1,
 *       allowH2: true, // HTTP/2 multiplexing
 *     }),
 *   }),
 *   baseURL: "https://inference.example.com",
 * })
 * ```
 */

import type { MisinaDriver, MisinaDriverFactory } from "../types.ts"
import { defineDriver } from "./_define.ts"

/**
 * Opaque handle for `undici.Dispatcher` (Agent / Pool / Client). We
 * intentionally don't import the type from `undici` so the package is
 * not a hard dependency at the type level. Pass the value you got
 * from `new Agent(...)` / `new Pool(...)` directly; we forward it as-
 * is to undici's `fetch`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UndiciDispatcher = any

export interface UndiciDriverOptions {
  /**
   * Pre-built undici `Agent` / `Pool` / `Client` to route every
   * request through. Created once in your app, reused across calls.
   * Required — without a dispatcher this driver collapses to a
   * dynamic-import wrapper around `globalThis.fetch`, defeating the
   * point of installing it.
   */
  dispatcher: UndiciDispatcher
  /**
   * Override the undici `fetch` import. Mostly for tests; otherwise
   * the driver lazy-imports `undici` on first call.
   */
  fetch?: (input: Request, init?: { dispatcher?: UndiciDispatcher }) => Promise<Response>
}

type UndiciFetch = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: UndiciDispatcher; duplex?: "half" },
) => Promise<Response>

const undiciDriver: MisinaDriverFactory<UndiciDriverOptions> = defineDriver<UndiciDriverOptions>(
  (options) => {
    let fetchImpl: UndiciFetch | undefined = options.fetch as UndiciFetch | undefined
    let importPromise: Promise<UndiciFetch> | undefined

    async function ensureFetch(): Promise<UndiciFetch> {
      if (fetchImpl) return fetchImpl
      if (!importPromise) {
        // Dynamic import keeps `undici` out of the static graph — the
        // package only loads when this driver is actually used.
        importPromise = import("undici").then((mod) => {
          const candidate = mod as unknown as {
            fetch?: UndiciFetch
            default?: { fetch?: UndiciFetch }
          }
          const f = candidate.fetch ?? candidate.default?.fetch
          if (typeof f !== "function") {
            throw new Error(
              "misina/driver/undici: `undici` package does not export `fetch`. Install undici ≥ 6.",
            )
          }
          fetchImpl = f
          return f
        })
      }
      return importPromise
    }

    return {
      name: "undici",
      request: async (request: Request): Promise<Response> => {
        const fetchUndici = await ensureFetch()
        // undici ≥ 8 doesn't accept a `Request` instance as the first
        // arg of its `fetch` (https://github.com/nodejs/undici/issues/4170).
        // Re-issue against the URL + init shape so the dispatcher
        // is honored across all undici majors.
        const init: RequestInit & { dispatcher?: UndiciDispatcher; duplex?: "half" } = {
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          redirect: request.redirect,
          dispatcher: options.dispatcher,
        }
        if (request.body) {
          init.body = request.body
          init.duplex = "half"
        }
        return fetchUndici(request.url, init)
      },
    } satisfies MisinaDriver
  },
)

export { undiciDriver }
export default undiciDriver

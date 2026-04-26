/**
 * `node:http2` driver — multiplexes streams over a single
 * `ClientHttp2Session` per origin, with auto-reconnect on `GOAWAY`
 * frames or session errors.
 *
 * Zero peer dep (uses the Node built-in). Less common than
 * `misina/driver/undici` (#73 covers 95% of pool-tuning cases); this
 * driver exists for environments where undici can't be installed
 * (lockdown profiles, custom dispatchers) and for HTTP/2-specific
 * features that need direct access to the session.
 *
 * @example
 * ```ts
 * import { http2Driver } from "misina/driver/http2"
 *
 * const api = createMisina({
 *   driver: http2Driver({
 *     sessionIdleTimeoutMs: 30_000,
 *   }),
 *   baseURL: "https://h2.example.com",
 * })
 * ```
 */

import type { MisinaDriver } from "../types.ts"

export interface Http2DriverOptions {
  /**
   * Idle timeout in ms before a session is closed and a new one is
   * lazily reopened on the next request. Default: 30_000.
   */
  sessionIdleTimeoutMs?: number
}

interface Http2Module {
  connect: (url: string | URL, options?: { rejectUnauthorized?: boolean }) => ClientHttp2Session
  constants: { HTTP2_HEADER_PATH: string; HTTP2_HEADER_METHOD: string }
}

interface ClientHttp2Session {
  request: (headers: Record<string, string | number | string[]>) => ClientHttp2Stream
  close: () => void
  destroy: (error?: Error) => void
  on: (event: string, listener: (...args: unknown[]) => void) => this
  off?: (event: string, listener: (...args: unknown[]) => void) => this
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => this
  closed: boolean
  destroyed: boolean
}

interface ClientHttp2Stream {
  on: (event: string, listener: (...args: unknown[]) => void) => this
  end: (data?: Buffer | string | Uint8Array) => void
  setEncoding: (encoding: string) => void
  destroy: (error?: Error) => void
  resume?: () => void
}

// Separate factory wrapper so callers can call `http2Driver()` (no
// argument) or `http2Driver({ sessionIdleTimeoutMs: 60_000 })`.
// `MisinaDriverFactory<TOptions | void>` distributes into a union
// that TS can't satisfy with a single arrow, so we wrap a normal
// optional-arg function and assert the return shape.
function http2Driver(rawOptions: Http2DriverOptions = {}): MisinaDriver {
  const options = rawOptions
  const idleMs = options.sessionIdleTimeoutMs ?? 30_000

  // One session per origin (`scheme://host:port`). Lazy-created.
  const sessions = new Map<string, ClientHttp2Session>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let http2Module: Http2Module | undefined

  async function ensureModule(): Promise<Http2Module> {
    if (http2Module) return http2Module
    const mod = (await import("node:http2")) as unknown as Http2Module
    http2Module = mod
    return mod
  }

  function bumpIdle(origin: string): void {
    const existing = idleTimers.get(origin)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      const session = sessions.get(origin)
      if (session && !session.closed && !session.destroyed) session.close()
      sessions.delete(origin)
      idleTimers.delete(origin)
    }, idleMs)
    // The timer must not keep the process alive (Node convention).
    ;(t as { unref?: () => void }).unref?.()
    idleTimers.set(origin, t)
  }

  async function getSession(origin: string): Promise<ClientHttp2Session> {
    const existing = sessions.get(origin)
    if (existing && !existing.closed && !existing.destroyed) {
      bumpIdle(origin)
      return existing
    }
    const mod = await ensureModule()
    const session = mod.connect(origin)
    // GOAWAY / error — drop the session so the *next* request opens a
    // fresh one. We don't reissue the in-flight request here; let
    // misina's retry policy decide.
    const drop = (): void => {
      sessions.delete(origin)
      const t = idleTimers.get(origin)
      if (t) clearTimeout(t)
      idleTimers.delete(origin)
    }
    session.on("goaway", drop)
    session.on("close", drop)
    session.on("error", drop)
    sessions.set(origin, session)
    bumpIdle(origin)
    return session
  }

  return {
    name: "http2",
    request: async (request: Request): Promise<Response> => {
      const mod = await ensureModule()
      const url = new URL(request.url)
      const origin = `${url.protocol}//${url.host}`
      const session = await getSession(origin)

      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of request.headers.entries()) headers[k] = v
      headers[mod.constants.HTTP2_HEADER_METHOD] = request.method
      headers[mod.constants.HTTP2_HEADER_PATH] = url.pathname + (url.search ?? "")

      // node:http2 derives :authority from the connect URL; passing
      // a Host header is redundant and some servers reject it.
      delete headers["host"]

      const body = request.body ? new Uint8Array(await request.clone().arrayBuffer()) : undefined

      return await new Promise<Response>((resolve, reject) => {
        const stream = session.request(headers)
        let status = 0
        const responseHeaders = new Headers()
        const chunks: Uint8Array[] = []
        let settled = false

        const cleanup = (): void => {
          // Idle timer is bumped already; no per-stream cleanup needed.
        }

        // We attach the error/end/data listeners *first*, then arm
        // the abort path. node:http2 streams emit `error` synchronously
        // from `destroy()`, so without a listener already in place
        // Node treats the error as uncaught.
        const onAbort = (): void => {
          if (settled) return
          settled = true
          // Close the stream gracefully (no `error` propagation) then
          // reject our promise. `close()` exists on http2 streams as
          // an alias for sending RST_STREAM.
          try {
            ;(stream as unknown as { close?: (code?: number) => void }).close?.(0x08 /* CANCEL */)
          } catch {
            // already closed
          }
          reject(new DOMException("Aborted", "AbortError"))
        }
        if (request.signal) {
          if (request.signal.aborted) {
            queueMicrotask(onAbort)
          } else {
            request.signal.addEventListener("abort", onAbort, { once: true })
          }
        }

        stream.on("response", (raw: unknown) => {
          const h = raw as Record<string, string | string[]>
          for (const [k, v] of Object.entries(h)) {
            if (k.startsWith(":")) {
              if (k === ":status") status = Number(Array.isArray(v) ? v[0] : v)
              continue
            }
            if (Array.isArray(v)) {
              for (const one of v) responseHeaders.append(k, one)
            } else {
              responseHeaders.set(k, v)
            }
          }
        })
        stream.on("data", (chunk: unknown) => {
          // Buffer is a Uint8Array under the hood.
          chunks.push(chunk as Uint8Array)
        })
        stream.on("end", () => {
          cleanup()
          if (settled) return
          settled = true
          const total = chunks.reduce((n, c) => n + c.byteLength, 0)
          const body = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            body.set(c, offset)
            offset += c.byteLength
          }
          resolve(
            new Response(body as BodyInit, {
              status: status || 200,
              headers: responseHeaders,
            }),
          )
        })
        stream.on("error", (err: unknown) => {
          cleanup()
          if (settled) return
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        })

        if (body && body.byteLength > 0) {
          stream.end(body)
        } else {
          stream.end()
        }
      })
    },
  } satisfies MisinaDriver
}

export { http2Driver }
export default http2Driver

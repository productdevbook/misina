import type { Misina, MisinaContext, MisinaPlugin } from "../types.ts"

export type TokenSource = string | (() => string | Promise<string>)

/**
 * Add an `Authorization: Bearer <token>` header to every request. Token can
 * be a string, a function, or a function returning a Promise — fetched once
 * per request.
 */
export function bearer(source: TokenSource): MisinaPlugin {
  return {
    name: "bearer",
    hooks: {
      beforeRequest: async (ctx) => {
        const token = await resolveToken(source)
        if (!token) return
        const headers = new Headers(ctx.request.headers)
        headers.set("authorization", `Bearer ${token}`)
        return new Request(ctx.request, { headers })
      },
    },
  }
}

/**
 * Add an `Authorization: Basic <base64>` header. Username and password are
 * base64'd on each request — function form supported for rotation.
 */
export function basic(user: TokenSource, pass: TokenSource): MisinaPlugin {
  return {
    name: "basic",
    hooks: {
      beforeRequest: async (ctx) => {
        const u = await resolveToken(user)
        const p = await resolveToken(pass)
        const headers = new Headers(ctx.request.headers)
        headers.set("authorization", `Basic ${base64(u + ":" + p)}`)
        return new Request(ctx.request, { headers })
      },
    },
  }
}

export interface RefreshOn401Options {
  /** Async function that refreshes the token. Concurrent 401s collapse onto one call. */
  refresh: () => string | Promise<string>
  /** Read the current token (used to set Authorization on the *next* request). */
  getToken?: () => string | Promise<string>
  /** Predicate to decide when to refresh. Default: `response.status === 401`. */
  shouldRefresh?: (ctx: MisinaContext) => boolean
}

/**
 * Refresh the auth token on a 401 response and retry the request once. All
 * concurrent 401s share a single in-flight refresh (mutex). A retried
 * request that itself returns 401 is NOT refreshed again — it surfaces to
 * the caller so they can prompt for re-login.
 *
 * Uses the `extend` slot because the afterResponse hook needs a reference
 * to the surrounding misina to dispatch the retry call.
 */
export function refreshOn401(opts: RefreshOn401Options): MisinaPlugin {
  let inflight: Promise<string> | undefined
  const shouldRefresh = opts.shouldRefresh ?? ((ctx) => ctx.response?.status === 401)
  // Tracks responses that came from a refresh-retry path. afterResponse
  // checks this set to break the recursion (refreshed token also rejected).
  const retriedResponses = new WeakSet<Response>()

  async function getNewToken(): Promise<string> {
    if (!inflight) {
      inflight = Promise.resolve(opts.refresh()).finally(() => {
        queueMicrotask(() => {
          inflight = undefined
        })
      })
    }
    return inflight
  }

  return {
    name: "refreshOn401",
    extend: (misina) =>
      misina.extend({
        hooks: {
          afterResponse: async (ctx) => {
            if (!ctx.response) return
            if (retriedResponses.has(ctx.response)) return
            if (!shouldRefresh(ctx)) return

            const newToken = await getNewToken()
            const headers = { ...ctx.options.headers }
            headers["authorization"] = `Bearer ${newToken}`

            const fresh = await fetchOnce(misina, ctx.request, headers)
            retriedResponses.add(fresh)
            return fresh
          },
        },
      }),
  }
}

async function fetchOnce(
  misina: Misina,
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  // responseType: 'stream' tells misina not to parse the body, so res.raw
  // is handed back fully readable to the outer afterResponse hook (which
  // returns it to be re-parsed once by finalizeResponse).
  const res = await misina.request(request.url, {
    method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
    headers,
    body: request.body ?? undefined,
    signal: request.signal,
    throwHttpErrors: false,
    retry: 0,
    responseType: "stream",
  })
  return res.raw
}

/**
 * Read a CSRF token from a cookie and echo it as a header. Common in
 * Django/Rails/Laravel apps.
 */
export function csrf(
  opts: {
    cookieName?: string
    headerName?: string
    /** Read cookies. Default: `document.cookie` in browser. */
    getCookies?: () => string
  } = {},
): MisinaPlugin {
  const cookieName = opts.cookieName ?? "XSRF-TOKEN"
  const headerName = opts.headerName ?? "X-XSRF-TOKEN"
  const getCookies = opts.getCookies ?? defaultGetCookies

  return {
    name: "csrf",
    hooks: {
      beforeRequest: (ctx) => {
        const cookies = safeCall(getCookies)
        if (!cookies) return
        const match = new RegExp(`(?:^|;\\s*)${escapeRe(cookieName)}=([^;]+)`).exec(cookies)
        if (!match || !match[1]) return
        const headers = new Headers(ctx.request.headers)
        headers.set(headerName, decodeURIComponent(match[1]))
        return new Request(ctx.request, { headers })
      },
    },
  }
}

function defaultGetCookies(): string {
  if (typeof document !== "undefined") return document.cookie
  return ""
}

function safeCall(fn: () => string): string {
  try {
    return fn()
  } catch {
    return ""
  }
}

function escapeRe(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function resolveToken(source: TokenSource): Promise<string> {
  return typeof source === "function" ? await source() : source
}

function base64(input: string): string {
  // UTF-8 safe: btoa alone takes Latin1 only and explodes on non-ASCII
  // user/pass (a real bug in browsers). Encode to bytes first, then
  // pack into a Latin1 string so btoa accepts it.
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

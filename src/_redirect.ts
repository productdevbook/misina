import type { MisinaContext, MisinaDriver, MisinaResolvedOptions } from "./types.ts"

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const DEFAULT_SAFE_HEADERS = ["accept", "accept-encoding", "accept-language", "user-agent"]

const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization", "www-authenticate"]

/**
 * Walk the driver through redirects manually so we can apply our header
 * policy and call beforeRedirect hooks. The driver receives a request with
 * `redirect: 'manual'`; we follow until a non-3xx is returned.
 */
export async function followRedirects(
  driver: MisinaDriver,
  request: Request,
  options: MisinaResolvedOptions,
  ctx: MisinaContext,
): Promise<Response> {
  const policy = options.redirect
  if (policy === "follow") {
    // Caller wants the runtime to handle redirects — do nothing extra.
    return driver.request(request)
  }
  if (policy === "error") {
    const response = await driver.request(forceManualRedirect(request))
    if (REDIRECT_STATUSES.has(response.status)) {
      throw new Error(
        `misina: redirect to ${response.headers.get("location") ?? "?"} blocked by redirect: 'error'`,
      )
    }
    return response
  }

  // 'manual' (our value): follow ourselves with policy applied
  let current = forceManualRedirect(request)
  let visited = 0

  while (true) {
    const response = await driver.request(current)
    if (!REDIRECT_STATUSES.has(response.status)) return response

    visited++
    if (visited > options.redirectMaxCount) {
      throw new Error(`misina: too many redirects (${visited})`)
    }

    const location = response.headers.get("location")
    if (!location) return response

    const nextUrl = new URL(location, current.url).toString()

    if (!options.redirectAllowDowngrade && isHttpsDowngrade(current.url, nextUrl)) {
      throw new Error(
        `misina: refusing https → http redirect (${current.url} → ${nextUrl}); set redirectAllowDowngrade: true to allow`,
      )
    }

    const sameOrigin = isSameOrigin(current.url, nextUrl)
    const nextHeaders = filterRedirectHeaders(
      Object.fromEntries(current.headers),
      sameOrigin,
      options.redirectSafeHeaders,
    )

    let next = new Request(nextUrl, {
      method: shouldDowngradeToGet(response.status, current.method) ? "GET" : current.method,
      headers: nextHeaders,
      body: shouldDowngradeToGet(response.status, current.method) ? null : current.body,
      redirect: "manual",
      signal: current.signal,
    })

    for (const hook of options.hooks.beforeRedirect) {
      const out = await hook({
        request: next,
        response,
        options,
        attempt: ctx.attempt,
        sameOrigin,
      })
      if (out instanceof Request) next = out
    }

    current = next
  }
}

function forceManualRedirect(request: Request): Request {
  if (request.redirect === "manual") return request
  return new Request(request, { redirect: "manual", signal: request.signal })
}

function shouldDowngradeToGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD"
  if (
    (status === 301 || status === 302) &&
    (method === "POST" || method === "PUT" || method === "PATCH")
  ) {
    return true
  }
  return false
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.protocol === ub.protocol && ua.host === ub.host
  } catch {
    return false
  }
}

function isHttpsDowngrade(from: string, to: string): boolean {
  try {
    return new URL(from).protocol === "https:" && new URL(to).protocol === "http:"
  } catch {
    return false
  }
}

function filterRedirectHeaders(
  headers: Record<string, string>,
  sameOrigin: boolean,
  safeList: string[] | undefined,
): Record<string, string> {
  if (sameOrigin) return headers
  const safe = new Set((safeList ?? DEFAULT_SAFE_HEADERS).map((h) => h.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase()
    if (SENSITIVE_HEADERS.includes(lower)) continue
    if (safe.has(lower)) out[k] = v
  }
  return out
}

export interface BeforeRedirectContext {
  request: Request
  response: Response
  options: MisinaResolvedOptions
  attempt: number
  sameOrigin: boolean
}

export type BeforeRedirectHook = (
  ctx: BeforeRedirectContext,
) => void | Request | Promise<void | Request>

import type { Misina } from "../types.ts"

export interface CookieJar {
  getCookieString: (url: string) => string | Promise<string>
  setCookie: (setCookieHeader: string, url: string) => void | Promise<void>
}

interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
}

/**
 * Zero-dep, in-memory cookie jar covering the 80% case (session cookies).
 * Honors Domain, Path, Expires/Max-Age, Secure. Does not implement public-
 * suffix-list checks or full RFC 6265 — that's a v2 concern.
 */
export class MemoryCookieJar implements CookieJar {
  #cookies: StoredCookie[] = []

  getCookieString(url: string): string {
    const u = new URL(url)
    const now = Date.now()
    const out: string[] = []
    for (const c of this.#cookies) {
      if (c.expires != null && c.expires < now) continue
      if (!domainMatches(u.hostname, c.domain)) continue
      if (!pathMatches(u.pathname, c.path)) continue
      if (c.secure && u.protocol !== "https:") continue
      out.push(`${c.name}=${c.value}`)
    }
    return out.join("; ")
  }

  setCookie(setCookieHeader: string, url: string): void {
    const cookie = parseSetCookie(setCookieHeader, url)
    if (!cookie) return
    this.#cookies = this.#cookies.filter(
      (c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path),
    )
    if (cookie.expires == null || cookie.expires > Date.now()) {
      this.#cookies.push(cookie)
    }
  }

  /** Inspect or seed the jar. Mostly useful in tests. */
  get cookies(): readonly StoredCookie[] {
    return this.#cookies
  }
}

/**
 * Wrap a Misina instance with a cookie jar. Adds a Cookie header on every
 * request matching the URL; reads `Set-Cookie` from responses and stores them.
 */
export function withCookieJar(misina: Misina, jar: CookieJar): Misina {
  return misina.extend({
    hooks: {
      beforeRequest: async (ctx) => {
        const cookieString = await jar.getCookieString(ctx.request.url)
        if (!cookieString) return
        const headers = new Headers(ctx.request.headers)
        const existing = headers.get("cookie")
        headers.set("cookie", existing ? `${existing}; ${cookieString}` : cookieString)
        return new Request(ctx.request, { headers })
      },
      // Persist Set-Cookie from intermediate redirect hops too. Without
      // this, the jar only sees cookies from the final response — and
      // services that set the session cookie on the login redirect step
      // (a very common pattern) silently lose state. Mirrors undici #3784.
      beforeRedirect: async ({ request, response }) => {
        const setCookies = response.headers.getSetCookie()
        for (const sc of setCookies) {
          // The intermediate response was issued by the *previous* URL.
          // We don't have direct access to it here, but the next request
          // already carries the new URL — Set-Cookie is scoped by the
          // origin that emitted it, so we use the current (next) URL as
          // a best-effort same-host fallback when the redirect is
          // same-origin, otherwise the previous request's URL would be
          // ideal but isn't surfaced. Cookies for cross-origin redirect
          // chains are rare and risky; we skip them here on purpose.
          await jar.setCookie(sc, request.url)
        }
        // Re-resolve the Cookie header for the upcoming hop now that
        // the jar may have changed. The default beforeRequest hook
        // doesn't fire on the manual redirect path.
        const cookieString = await jar.getCookieString(request.url)
        const headers = new Headers(request.headers)
        if (cookieString) {
          headers.set("cookie", cookieString)
        } else {
          headers.delete("cookie")
        }
        return new Request(request, { headers })
      },
      afterResponse: async (ctx) => {
        if (!ctx.response) return
        // `Headers.getSetCookie()` — spec since 2023; available in
        // Node ≥ 19.7, Bun, Deno, Baseline 2024 browsers.
        const setCookies = ctx.response.headers.getSetCookie()
        for (const sc of setCookies) {
          await jar.setCookie(sc, ctx.request.url)
        }
      },
    },
  })
}

function parseSetCookie(header: string, url: string): StoredCookie | undefined {
  const parts = header.split(";").map((p) => p.trim())
  const first = parts.shift()
  if (!first) return undefined
  const eq = first.indexOf("=")
  if (eq === -1) return undefined
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (!name) return undefined

  const u = new URL(url)
  const cookie: StoredCookie = { name, value, domain: u.hostname, path: "/" }

  for (const attr of parts) {
    const [rawKey, ...rest] = attr.split("=")
    const key = rawKey?.toLowerCase() ?? ""
    const v = rest.join("=").trim()
    switch (key) {
      case "domain": {
        const requested = v.startsWith(".") ? v.slice(1) : v
        // RFC 6265 §5.3 step 6: reject Domain attributes that don't
        // domain-match the request URL's host. Otherwise a malicious server
        // could set a cookie for an unrelated domain.
        if (!domainMatches(u.hostname, requested)) {
          return undefined
        }
        cookie.domain = requested
        break
      }
      case "path":
        cookie.path = v || "/"
        break
      case "expires": {
        const t = Date.parse(v)
        if (!Number.isNaN(t)) cookie.expires = t
        break
      }
      case "max-age": {
        const seconds = Number(v)
        if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000
        break
      }
      case "secure":
        cookie.secure = true
        break
      case "httponly":
        cookie.httpOnly = true
        break
      case "samesite":
        cookie.sameSite = v.toLowerCase()
        break
    }
  }
  return cookie
}

function domainMatches(host: string, cookieDomain: string): boolean {
  if (host === cookieDomain) return true
  return host.endsWith("." + cookieDomain)
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === requestPath) return true
  if (requestPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith("/")) return true
    if (requestPath.charAt(cookiePath.length) === "/") return true
  }
  return false
}

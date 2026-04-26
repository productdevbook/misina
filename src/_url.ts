import type { ArrayFormat, ParamsSerializer } from "./types.ts"

/**
 * Resolve a request input against an optional baseURL using the WHATWG URL
 * parser. Never string-concats — that's the SSRF-prone path used by ofetch.
 *
 * `allowAbsoluteUrls` (default true) controls whether an absolute URL in
 * `input` overrides `baseURL`. Set to false when the caller must be
 * confined to baseURL's origin.
 *
 * `allowedProtocols` (default `['http','https']`) gates which URL schemes
 * are permitted. Embedded runtimes (Capacitor, Tauri) can opt in to their
 * custom schemes by extending the list.
 */
export type TrailingSlashPolicy = "preserve" | "strip" | "forbid"

export function resolveUrl(
  input: string,
  baseURL: string | undefined,
  allowAbsoluteUrls = true,
  allowedProtocols: readonly string[] = ["http", "https"],
  trailingSlash: TrailingSlashPolicy = "preserve",
): string {
  assertNoControlChars(input, "input")
  if (baseURL !== undefined) assertNoControlChars(baseURL, "baseURL")
  let resolved: string
  if (isAbsoluteUrl(input)) {
    if (!allowAbsoluteUrls && baseURL) {
      throw new Error(
        `misina: absolute URL ${JSON.stringify(input)} rejected because allowAbsoluteUrls is false`,
      )
    }
    resolved = input
  } else if (!baseURL) {
    resolved = input
  } else {
    resolved = new URL(input, ensureTrailingSlash(baseURL)).toString()
  }
  assertAllowedProtocol(resolved, allowedProtocols)
  return applyTrailingSlash(resolved, trailingSlash)
}

function applyTrailingSlash(url: string, policy: TrailingSlashPolicy): string {
  if (policy === "preserve") return url
  // Find the path component without parsing — keeps relative URLs intact.
  // Strip any query/hash before checking the trailing char.
  const queryAt = url.indexOf("?")
  const hashAt = url.indexOf("#")
  const pathEnd = Math.min(
    queryAt === -1 ? url.length : queryAt,
    hashAt === -1 ? url.length : hashAt,
  )
  const path = url.slice(0, pathEnd)
  const tail = url.slice(pathEnd)
  // Don't touch a bare scheme://host — there's no path to strip.
  if (!path.endsWith("/") || /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(path)) return url
  if (policy === "forbid") {
    throw new Error(
      `misina: trailing slash on ${JSON.stringify(url)} rejected because trailingSlash is "forbid"`,
    )
  }
  // policy === "strip"
  return path.replace(/\/+$/, "") + tail
}

function assertAllowedProtocol(url: string, allowed: readonly string[]): void {
  // Skip the check for relative paths — they have no protocol of their own
  // (the runtime/driver supplies one). Only validate parseable URLs.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  // URL.protocol returns "http:" — strip the trailing colon to compare.
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase()
  if (!allowed.includes(scheme)) {
    throw new Error(
      `misina: protocol "${parsed.protocol}" not in allowedProtocols (${allowed.join(", ")})`,
    )
  }
}

function isAbsoluteUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(input)
}

function assertNoControlChars(value: string, label: string): void {
  // CR/LF/NUL in a URL composition is request-smuggling territory. WHATWG
  // URL parser tolerates some of these silently — explicit reject keeps
  // the wire format honest. ofetch hit this in unjs/ofetch#530.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 0x00 || code === 0x0a || code === 0x0d) {
      throw new Error(`misina: ${label} contains CR/LF/NUL (offset ${i})`)
    }
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/"
}

/**
 * Append/merge a query record onto a URL string.
 *
 * - `undefined`/`null` values are skipped silently.
 * - Arrays are serialized per `arrayFormat`:
 *   - `'repeat'` (default): `?a=1&a=2`
 *   - `'brackets'`: `?a[]=1&a[]=2`
 *   - `'comma'`: `?a=1,2`
 *   - `'indices'`: `?a[0]=1&a[1]=2`
 * - `URLSearchParams` and `string` query values are merged as-is.
 * - Custom `paramsSerializer` overrides the entire mechanism.
 */
export function appendQuery(
  url: string,
  query: Record<string, unknown> | URLSearchParams | string | undefined,
  arrayFormat: ArrayFormat = "repeat",
  paramsSerializer?: ParamsSerializer,
): string {
  if (query == null) return url

  const u = new URL(url)

  if (paramsSerializer && !(query instanceof URLSearchParams) && typeof query !== "string") {
    const serialized = paramsSerializer(query as Record<string, unknown>)
    appendQueryString(u, serialized)
    return u.toString()
  }

  if (typeof query === "string") {
    appendQueryString(u, query)
    return u.toString()
  }

  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) u.searchParams.append(key, value)
    return u.toString()
  }

  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      // Drop null/undefined items inside arrays — same rule as top-level.
      const items = value.filter((v): v is NonNullable<typeof v> => v != null)
      if (items.length === 0) continue
      switch (arrayFormat) {
        case "repeat":
          for (const v of items) u.searchParams.append(key, String(v))
          break
        case "brackets":
          for (const v of items) u.searchParams.append(`${key}[]`, String(v))
          break
        case "comma":
          u.searchParams.append(key, items.map(String).join(","))
          break
        case "indices":
          items.forEach((v, i) => u.searchParams.append(`${key}[${i}]`, String(v)))
          break
      }
    } else {
      u.searchParams.append(key, String(value))
    }
  }

  return u.toString()
}

function appendQueryString(url: URL, qs: string): void {
  const trimmed = qs.startsWith("?") ? qs.slice(1) : qs
  if (!trimmed) return
  const parsed = new URLSearchParams(trimmed)
  for (const [key, value] of parsed) url.searchParams.append(key, value)
}

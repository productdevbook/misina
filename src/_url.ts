/**
 * Resolve a request input against an optional baseURL using the WHATWG URL
 * parser. We never string-concat — that's the SSRF-prone path used by ofetch.
 */
export function resolveUrl(input: string, baseURL?: string): string {
  if (!baseURL) return input
  return new URL(input, ensureTrailingSlash(baseURL)).toString()
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/"
}

/**
 * Append/merge a query record onto a URL string. `undefined` values are
 * skipped; arrays produce repeated keys (`?a=1&a=2`).
 */
export function appendQuery(url: string, query: Record<string, unknown> | undefined): string {
  if (!query) return url
  const u = new URL(url)
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) u.searchParams.append(key, String(v))
    } else {
      u.searchParams.append(key, String(value))
    }
  }
  return u.toString()
}

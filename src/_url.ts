/**
 * Resolve a request input against an optional baseURL using the WHATWG URL
 * parser. Never string-concats — that's the SSRF-prone path used by ofetch.
 *
 * `allowAbsoluteUrls` (default true) controls whether an absolute URL in
 * `input` overrides `baseURL`. Set to false when the caller must be
 * confined to baseURL's origin (e.g. server-side request with user input).
 */
export function resolveUrl(
  input: string,
  baseURL: string | undefined,
  allowAbsoluteUrls = true,
): string {
  if (isAbsoluteUrl(input)) {
    if (!allowAbsoluteUrls && baseURL) {
      throw new Error(
        `misina: absolute URL ${JSON.stringify(input)} rejected because allowAbsoluteUrls is false`,
      )
    }
    return input
  }
  if (!baseURL) return input
  return new URL(input, ensureTrailingSlash(baseURL)).toString()
}

function isAbsoluteUrl(input: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(input)
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

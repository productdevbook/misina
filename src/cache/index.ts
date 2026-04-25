import type { HttpMethod, Misina, MisinaContext } from "../types.ts"

export interface CacheEntry {
  response: Response
  expires: number
  etag?: string
  lastModified?: string
  /** Header values that contributed to the cache key, per Vary. */
  vary?: Record<string, string | null>
}

export interface CacheStore {
  get: (key: string) => CacheEntry | undefined | Promise<CacheEntry | undefined>
  set: (key: string, entry: CacheEntry) => void | Promise<void>
  delete: (key: string) => void | Promise<void>
  clear?: () => void | Promise<void>
}

export interface CacheOptions {
  store?: CacheStore
  /** Time-to-live in milliseconds. Default: 60_000. */
  ttl?: number
  /** Methods eligible for caching. Default: GET only. */
  methods?: HttpMethod[]
  /** Compute the cache key. Default: `${method} ${url}`. */
  key?: (ctx: MisinaContext) => string
  /** Send `If-None-Match`/`If-Modified-Since` for stale entries. Default: true. */
  revalidate?: boolean
  /**
   * Honor `Cache-Control: max-age=N` from responses, overriding the local
   * `ttl` option for that entry. Default: true.
   */
  honorCacheControl?: boolean
}

/** In-memory LRU-ish cache (no eviction by default — pair with `max`). */
export function memoryStore(opts: { max?: number } = {}): CacheStore {
  const map = new Map<string, CacheEntry>()
  const max = opts.max ?? Infinity

  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry)
      if (map.size > max) {
        const oldestKey = map.keys().next().value
        if (oldestKey != null) map.delete(oldestKey)
      }
    },
    delete: (key) => void map.delete(key),
    clear: () => map.clear(),
  }
}

const DEFAULT_METHODS: HttpMethod[] = ["GET"]

/**
 * Wrap a Misina with a response cache. Caches by `${method} ${url}` plus
 * any headers listed in the response's `Vary` (RFC 9111 §4.1). Honors
 * `Cache-Control: no-store` (skip cache), `Cache-Control: max-age=N`
 * (override TTL), and ETag / Last-Modified for revalidation.
 */
export function withCache(misina: Misina, opts: CacheOptions = {}): Misina {
  const store = opts.store ?? memoryStore()
  const ttl = opts.ttl ?? 60_000
  const methods = opts.methods ?? DEFAULT_METHODS
  const keyOf = opts.key ?? ((ctx) => `${ctx.options.method} ${ctx.options.url}`)
  const revalidate = opts.revalidate !== false
  const honorCacheControl = opts.honorCacheControl !== false

  return misina.extend({
    hooks: {
      beforeRequest: async (ctx) => {
        if (!methods.includes(ctx.options.method)) return
        const baseKey = keyOf(ctx)
        // Try the base key first; if that entry has Vary, build a per-variant
        // key from the request headers and look that up too.
        const baseEntry = await store.get(baseKey)
        const variantKey = baseEntry?.vary
          ? variantKeyFor(baseKey, baseEntry.vary, ctx.request.headers)
          : undefined
        const entry = variantKey ? await store.get(variantKey) : baseEntry
        if (!entry) return

        if (entry.vary && !varyMatches(entry.vary, ctx.request.headers)) return

        if (entry.expires > Date.now()) {
          return entry.response.clone()
        }

        if (revalidate) {
          const headers = new Headers(ctx.request.headers)
          if (entry.etag) headers.set("if-none-match", entry.etag)
          if (entry.lastModified) headers.set("if-modified-since", entry.lastModified)
          return new Request(ctx.request, { headers })
        }
      },
      afterResponse: async (ctx) => {
        if (!ctx.response) return
        if (!methods.includes(ctx.options.method)) return
        const baseKey = keyOf(ctx)

        if (ctx.response.status === 304) {
          const entry = await store.get(baseKey)
          if (entry) {
            await store.set(baseKey, { ...entry, expires: Date.now() + ttl })
            return entry.response.clone()
          }
        }

        if (!ctx.response.ok) return

        // RFC 9111 §5.2.1.5: no-store bans caching entirely.
        const cacheControl = ctx.response.headers.get("cache-control") ?? ""
        if (/(?:^|,)\s*no-store\b/i.test(cacheControl)) return

        // RFC 9111 §5.2.1.1: max-age overrides our TTL when honored.
        let entryTtl = ttl
        if (honorCacheControl) {
          const maxAge = parseMaxAge(cacheControl)
          if (maxAge != null) entryTtl = maxAge * 1000
        }

        const cloned = ctx.response.clone()
        const vary = recordVaryHeaders(ctx.response, ctx.request)

        const entry: CacheEntry = {
          response: cloned,
          expires: Date.now() + entryTtl,
          etag: ctx.response.headers.get("etag") ?? undefined,
          lastModified: ctx.response.headers.get("last-modified") ?? undefined,
          vary,
        }

        if (vary && !("*" in vary)) {
          // Store the per-variant entry under a derived key, but also keep the
          // base entry's `vary` field so subsequent requests know to look up
          // a variant.
          const variantKey = variantKeyFor(baseKey, vary, ctx.request.headers)
          await store.set(variantKey, entry)
          await store.set(baseKey, { ...entry, response: ctx.response.clone() })
        } else {
          await store.set(baseKey, entry)
        }
      },
    },
  })
}

function variantKeyFor(
  baseKey: string,
  vary: Record<string, string | null>,
  headers: Headers,
): string {
  const parts = Object.keys(vary)
    .sort()
    .map((name) => `${name}=${headers.get(name) ?? ""}`)
  return `${baseKey} | ${parts.join(" & ")}`
}

function parseMaxAge(cacheControl: string): number | null {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl)
  if (!match || !match[1]) return null
  return Number(match[1])
}

function recordVaryHeaders(
  response: Response,
  request: Request,
): Record<string, string | null> | undefined {
  const vary = response.headers.get("vary")
  if (!vary) return undefined
  // RFC 9111 §4.1: `Vary: *` means never reuse without revalidation.
  if (vary.trim() === "*") return { "*": null }
  const out: Record<string, string | null> = {}
  for (const name of vary.split(",")) {
    const trimmed = name.trim().toLowerCase()
    if (!trimmed) continue
    out[trimmed] = request.headers.get(trimmed)
  }
  return out
}

function varyMatches(stored: Record<string, string | null>, requestHeaders: Headers): boolean {
  if ("*" in stored) return false
  for (const [name, value] of Object.entries(stored)) {
    if (requestHeaders.get(name) !== value) return false
  }
  return true
}

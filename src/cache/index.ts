import type { HttpMethod, Misina, MisinaContext } from "../types.ts"

export interface CacheEntry {
  response: Response
  expires: number
  etag?: string
  lastModified?: string
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
 * Wrap a Misina with a response cache. Caches by `${method} ${url}` by
 * default; honors ETag / Last-Modified for revalidation (304 → reuse).
 */
export function withCache(misina: Misina, opts: CacheOptions = {}): Misina {
  const store = opts.store ?? memoryStore()
  const ttl = opts.ttl ?? 60_000
  const methods = opts.methods ?? DEFAULT_METHODS
  const keyOf = opts.key ?? ((ctx) => `${ctx.options.method} ${ctx.options.url}`)
  const revalidate = opts.revalidate !== false

  return misina.extend({
    hooks: {
      beforeRequest: async (ctx) => {
        if (!methods.includes(ctx.options.method)) return
        const key = keyOf(ctx)
        const entry = await store.get(key)
        if (!entry) return

        if (entry.expires > Date.now()) {
          // Fresh — short-circuit fetch
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
        const key = keyOf(ctx)

        if (ctx.response.status === 304) {
          const entry = await store.get(key)
          if (entry) {
            // Refresh expiry
            await store.set(key, { ...entry, expires: Date.now() + ttl })
            return entry.response.clone()
          }
        }

        if (ctx.response.ok) {
          const cloned = ctx.response.clone()
          await store.set(key, {
            response: cloned,
            expires: Date.now() + ttl,
            etag: ctx.response.headers.get("etag") ?? undefined,
            lastModified: ctx.response.headers.get("last-modified") ?? undefined,
          })
        }
      },
    },
  })
}

import { parseSfList, type SfBareItem } from "../_sf.ts"
import type { HttpMethod, MisinaContext, MisinaPlugin } from "../types.ts"

export interface CacheEntry {
  response: Response
  expires: number
  etag?: string
  lastModified?: string
  /** Header values that contributed to the cache key, per Vary. */
  vary?: Record<string, string | null>
  /**
   * RFC 5861 stale-while-revalidate window in milliseconds. While in this
   * window the entry is served stale and revalidated in the background.
   */
  staleWhileRevalidate?: number
  /**
   * RFC 5861 stale-if-error window in milliseconds. When the origin
   * fails (5xx, network error) within this window the cached entry is
   * served instead of the failure.
   */
  staleIfError?: number
  /** RFC 8246 — entry is guaranteed fresh until `expires`, no revalidation. */
  immutable?: boolean
}

export interface ParsedCacheControl {
  maxAge?: number
  sMaxAge?: number
  noStore?: boolean
  noCache?: boolean
  immutable?: boolean
  public?: boolean
  private?: boolean
  staleWhileRevalidate?: number
  staleIfError?: number
}

/**
 * Parse a `Cache-Control` header value (RFC 9111, RFC 5861, RFC 8246).
 * Unknown directives are ignored. Tolerant of whitespace and case.
 */
export function parseCacheControl(header: string | null | undefined): ParsedCacheControl {
  const out: ParsedCacheControl = {}
  if (!header) return out
  for (const raw of header.split(",")) {
    const part = raw.trim()
    if (!part) continue
    const eq = part.indexOf("=")
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase()
    const rawValue =
      eq === -1
        ? ""
        : part
            .slice(eq + 1)
            .trim()
            .replace(/^"|"$/g, "")
    switch (name) {
      case "max-age": {
        const n = Number(rawValue)
        if (Number.isFinite(n) && n >= 0) out.maxAge = n
        break
      }
      case "s-maxage": {
        const n = Number(rawValue)
        if (Number.isFinite(n) && n >= 0) out.sMaxAge = n
        break
      }
      case "stale-while-revalidate": {
        const n = Number(rawValue)
        if (Number.isFinite(n) && n >= 0) out.staleWhileRevalidate = n
        break
      }
      case "stale-if-error": {
        const n = Number(rawValue)
        if (Number.isFinite(n) && n >= 0) out.staleIfError = n
        break
      }
      case "no-store":
        out.noStore = true
        break
      case "no-cache":
        out.noCache = true
        break
      case "immutable":
        out.immutable = true
        break
      case "public":
        out.public = true
        break
      case "private":
        out.private = true
        break
    }
  }
  return out
}

/**
 * RFC 9211 Cache-Status header. Each list member identifies a cache by
 * token (or string) and carries parameters like `hit`, `fwd=miss`,
 * `ttl=NNN`, etc.
 */
export interface CacheStatusEntry {
  /** Cache identifier (token or quoted string). */
  cache: string
  hit?: boolean
  fwd?: string
  fwdStatus?: number
  ttl?: number
  stored?: boolean
  collapsed?: boolean
  key?: string
  detail?: string
  /** Any unknown parameters preserved as-is. */
  params: Record<string, string | number | boolean>
}

/**
 * Parse a `Cache-Status` header (RFC 9211) into ordered entries — first
 * entry is the cache nearest to the origin, last is the cache nearest to
 * the user (per RFC 9211 §2). Returns an empty array on parse failure.
 */
export function parseCacheStatus(header: string | null | undefined): CacheStatusEntry[] {
  if (!header) return []
  const list = parseSfList(header)
  if (!list) return []
  const out: CacheStatusEntry[] = []
  for (const member of list) {
    if (!("value" in member) || Array.isArray(member.value)) continue
    const v = member.value
    let cache: string | null = null
    if (typeof v === "string") cache = v
    else if (typeof v === "object" && v !== null && "token" in v) cache = v.token
    if (cache === null) continue
    const entry: CacheStatusEntry = { cache, params: {} }
    for (const [key, raw] of Object.entries(member.params)) {
      const val = unwrapToken(raw)
      switch (key) {
        case "hit":
          entry.hit = val === true
          break
        case "fwd":
          if (typeof val === "string") entry.fwd = val
          break
        case "fwd-status":
          if (typeof val === "number") entry.fwdStatus = val
          break
        case "ttl":
          if (typeof val === "number") entry.ttl = val
          break
        case "stored":
          entry.stored = val === true
          break
        case "collapsed":
          entry.collapsed = val === true
          break
        case "key":
          if (typeof val === "string") entry.key = val
          break
        case "detail":
          if (typeof val === "string") entry.detail = val
          break
      }
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        entry.params[key] = val
      }
    }
    out.push(entry)
  }
  return out
}

function unwrapToken(item: SfBareItem): string | number | boolean | null {
  if (typeof item === "string") return item
  if (typeof item === "number") return item
  if (typeof item === "boolean") return item
  if (typeof item === "object" && item !== null && "token" in item) return item.token
  return null
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
  /**
   * Decide whether to cache a given response. Receives the request and the
   * response that's about to be cached; return `false` to skip storing.
   * Useful to filter out 5xx, error envelopes, or sensitive paths.
   */
  shouldStore?: (request: Request, response: Response) => boolean
  /**
   * Mutate a cache entry before it's stored. Receives the entry; return a
   * replacement or `undefined` to abandon caching this entry. Use to scrub
   * secrets, denormalize, or attach metadata.
   */
  beforeStore?: (entry: CacheEntry) => CacheEntry | undefined | Promise<CacheEntry | undefined>
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
export function cache(opts: CacheOptions = {}): MisinaPlugin {
  const store = opts.store ?? memoryStore()
  const ttl = opts.ttl ?? 60_000
  const methods = opts.methods ?? DEFAULT_METHODS
  const keyOf = opts.key ?? ((ctx) => `${ctx.options.method} ${ctx.options.url}`)
  const revalidate = opts.revalidate !== false
  const honorCacheControl = opts.honorCacheControl !== false

  return {
    name: "cache",
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

        const now = Date.now()
        if (entry.expires > now) {
          // RFC 8246: immutable entries skip every revalidation knob; the
          // server has promised the body cannot change before `expires`.
          return entry.response.clone()
        }

        // RFC 5861 stale-while-revalidate: if we're still within the SWR
        // window, return the stale entry now and refresh in the background.
        const swr = entry.staleWhileRevalidate ?? 0
        if (swr > 0 && now - entry.expires < swr) {
          // Fire-and-forget revalidation. We can't access the Misina
          // instance from inside the hook; instead, kick a parallel fetch
          // that mirrors the request and store-overwrites on success.
          void revalidateInBackground(ctx, store, baseKey, ttl, honorCacheControl, opts)
          return entry.response.clone()
        }

        if (revalidate && !entry.immutable) {
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

        if (!ctx.response.ok) {
          // RFC 5861 stale-if-error: serve the cached entry on 5xx within
          // the SIE window. 4xx/3xx are not eligible — those are usually
          // intentional and shouldn't be masked.
          if (ctx.response.status >= 500) {
            const entry = await store.get(baseKey)
            if (entry && isWithinStaleIfError(entry)) {
              return entry.response.clone()
            }
          }
          return
        }

        // RFC 9111 §5.2.1.5: no-store bans caching entirely.
        const cacheControl = ctx.response.headers.get("cache-control") ?? ""
        const cc = parseCacheControl(cacheControl)
        if (cc.noStore) return

        // User filter — opt out of storing this response entirely.
        if (opts.shouldStore && !opts.shouldStore(ctx.request, ctx.response)) return

        // RFC 9111 §5.2.1.1: max-age overrides our TTL when honored.
        let entryTtl = ttl
        if (honorCacheControl && cc.maxAge != null) entryTtl = cc.maxAge * 1000

        const cloned = ctx.response.clone()
        const vary = recordVaryHeaders(ctx.response, ctx.request)

        let entry: CacheEntry = {
          response: cloned,
          expires: Date.now() + entryTtl,
          etag: ctx.response.headers.get("etag") ?? undefined,
          lastModified: ctx.response.headers.get("last-modified") ?? undefined,
          vary,
          staleWhileRevalidate:
            honorCacheControl && cc.staleWhileRevalidate != null
              ? cc.staleWhileRevalidate * 1000
              : undefined,
          staleIfError:
            honorCacheControl && cc.staleIfError != null ? cc.staleIfError * 1000 : undefined,
          immutable: honorCacheControl && cc.immutable === true ? true : undefined,
        }

        // User mutator — last hook before write. Returning undefined skips.
        if (opts.beforeStore) {
          const out = await opts.beforeStore(entry)
          if (!out) return
          entry = out
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
  }
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

function isWithinStaleIfError(entry: CacheEntry): boolean {
  if (!entry.staleIfError) return false
  return Date.now() - entry.expires < entry.staleIfError
}

async function revalidateInBackground(
  ctx: MisinaContext,
  store: CacheStore,
  baseKey: string,
  ttl: number,
  honorCacheControl: boolean,
  opts: CacheOptions,
): Promise<void> {
  try {
    const headers = new Headers(ctx.request.headers)
    // Force a network read so we see fresh Cache-Control + body, even if
    // the upstream would 304 us — we need to refresh the stored entry.
    const response = await fetch(ctx.request.url, {
      method: ctx.request.method,
      headers,
    })
    if (!response.ok) return
    const cc = parseCacheControl(response.headers.get("cache-control") ?? "")
    if (cc.noStore) return
    if (opts.shouldStore && !opts.shouldStore(ctx.request, response)) return
    const entryTtl = honorCacheControl && cc.maxAge != null ? cc.maxAge * 1000 : ttl
    let entry: CacheEntry = {
      response: response.clone(),
      expires: Date.now() + entryTtl,
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      staleWhileRevalidate:
        honorCacheControl && cc.staleWhileRevalidate != null
          ? cc.staleWhileRevalidate * 1000
          : undefined,
      staleIfError:
        honorCacheControl && cc.staleIfError != null ? cc.staleIfError * 1000 : undefined,
      immutable: honorCacheControl && cc.immutable === true ? true : undefined,
    }
    if (opts.beforeStore) {
      const out = await opts.beforeStore(entry)
      if (!out) return
      entry = out
    }
    await store.set(baseKey, entry)
  } catch {
    // Background revalidation must never throw; the stale entry stays
    // valid and we'll try again on the next request.
  }
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

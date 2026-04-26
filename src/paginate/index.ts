import type { Misina, MisinaRequestInit, MisinaResponse } from "../types.ts"

export interface PaginateContext {
  attempt: number
  response: MisinaResponse<unknown>
  url: string
}

export interface PaginateOptions<T, R = unknown> {
  /** Extract the page items from a response. Default: `res.data` if array, else `[]`. */
  transform?: (response: MisinaResponse<R>) => T[] | Promise<T[]>
  /** Filter items per page. */
  filter?: (item: T) => boolean
  /**
   * Build the next request. Return `false` to stop. Return a partial init to
   * issue a follow-up request. If omitted, follows `Link: rel=next` headers.
   */
  next?: (
    response: MisinaResponse<R>,
    ctx: PaginateContext,
  ) =>
    | false
    | { url?: string; init?: MisinaRequestInit }
    | Promise<false | { url?: string; init?: MisinaRequestInit }>
  /** Stop after N total items. */
  countLimit?: number
  /** Stop after N requests. */
  requestLimit?: number
}

/**
 * Async-iterate over a paginated REST endpoint. Default behavior follows the
 * `Link: rel="next"` header (RFC 5988). Use `next` for cursor or page-number
 * APIs.
 *
 * ```ts
 * for await (const user of paginate(misina, "/users")) { ... }
 * ```
 *
 * Built-in cycle detection: if the same URL is visited twice without a
 * change in `init`, the iterator stops (prevents infinite loops on a
 * misconfigured `next` callback).
 */
export function paginate<T = unknown, R = unknown>(
  misina: Misina,
  input: string,
  options: PaginateOptions<T, R> = {},
  init?: MisinaRequestInit,
): AsyncIterableIterator<T> & AsyncDisposable {
  return ensureDisposable(_paginate<T, R>(misina, input, options, init))
}

function ensureDisposable<T>(iter: AsyncIterable<T>): AsyncIterableIterator<T> & AsyncDisposable {
  const inner = iter[Symbol.asyncIterator]() as AsyncIterableIterator<T>
  if (typeof (inner as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose] === "function") {
    return inner as AsyncIterableIterator<T> & AsyncDisposable
  }
  const wrapped: AsyncIterableIterator<T> & AsyncDisposable = {
    next: inner.next.bind(inner) as AsyncIterableIterator<T>["next"],
    return: inner.return ? inner.return.bind(inner) : undefined,
    throw: inner.throw ? inner.throw.bind(inner) : undefined,
    [Symbol.asyncIterator](): AsyncIterableIterator<T> & AsyncDisposable {
      return wrapped
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await inner.return?.(undefined as unknown as T)
    },
  }
  return wrapped
}

async function* _paginate<T = unknown, R = unknown>(
  misina: Misina,
  input: string,
  options: PaginateOptions<T, R> = {},
  init?: MisinaRequestInit,
): AsyncGenerator<T> {
  const transform = options.transform ?? defaultTransform
  const next = options.next ?? defaultNext

  let url: string | undefined = input
  let attemptInit = init
  let attempt = 0
  let yielded = 0
  const seen = new Set<string>()

  while (url != null) {
    if (options.requestLimit != null && attempt >= options.requestLimit) return

    // Cycle guard: if the next callback returns the same URL with the
    // same init, abort instead of looping forever.
    const fingerprint = `${url}|${JSON.stringify(attemptInit ?? null)}`
    if (seen.has(fingerprint)) return
    seen.add(fingerprint)

    const response = await misina.request<R>(url, attemptInit)
    attempt++

    const items = await transform(response)
    for (const item of items) {
      if (options.filter && !options.filter(item)) continue
      yield item
      yielded++
      if (options.countLimit != null && yielded >= options.countLimit) return
    }

    const decision = await next(response, { attempt, response, url })
    if (decision === false) return
    if (decision == null) return

    url = decision.url ?? url
    attemptInit = decision.init ?? attemptInit
  }
}

/** Materialize a paginator into an array. */
export async function paginateAll<T = unknown, R = unknown>(
  misina: Misina,
  input: string,
  options: PaginateOptions<T, R> = {},
  init?: MisinaRequestInit,
): Promise<T[]> {
  const out: T[] = []
  for await (const item of paginate<T, R>(misina, input, options, init)) {
    out.push(item)
  }
  return out
}

function defaultTransform<T, R>(response: MisinaResponse<R>): T[] {
  const data = response.data
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
    return (data as unknown as { data: T[] }).data
  }
  return []
}

function defaultNext<R>(
  response: MisinaResponse<R>,
): false | { url?: string; init?: MisinaRequestInit } {
  const link = response.headers["link"]
  if (!link) return false
  const next = parseLinkHeader(link).next
  if (!next) return false
  return { url: next }
}

/**
 * Parse a `Link` header (RFC 8288 §3) into a `{ rel: url }` map. Splitting on
 * raw commas is wrong because URLs can contain commas (e.g.
 * `/items?ids=1,2,3`). We instead walk the header, treating `<...>` as the
 * URL and consuming params up to the next top-level comma.
 */
function parseLinkHeader(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < value.length) {
    // Skip whitespace and leading commas
    while (i < value.length && (value[i] === "," || value[i] === " " || value[i] === "\t")) i++
    if (i >= value.length) break
    if (value[i] !== "<") break // malformed
    const close = value.indexOf(">", i + 1)
    if (close === -1) break
    const url = value.slice(i + 1, close)
    i = close + 1

    // Walk parameters until the next top-level comma.
    let rel: string | undefined
    while (i < value.length && value[i] !== ",") {
      // Skip ; and whitespace
      while (i < value.length && (value[i] === ";" || value[i] === " " || value[i] === "\t")) i++
      if (i >= value.length || value[i] === ",") break
      // Read param name
      const eq = value.indexOf("=", i)
      const semi = value.indexOf(";", i)
      const comma = value.indexOf(",", i)
      const end = nextStop(eq, semi, comma, value.length)
      const name = value.slice(i, end).trim().toLowerCase()
      i = end
      if (value[i] === "=") {
        i++
        let pval: string
        if (value[i] === '"') {
          const q = value.indexOf('"', i + 1)
          if (q === -1) {
            pval = value.slice(i + 1)
            i = value.length
          } else {
            pval = value.slice(i + 1, q)
            i = q + 1
          }
        } else {
          const stopSemi = value.indexOf(";", i)
          const stopComma = value.indexOf(",", i)
          const stop = nextStop(stopSemi, stopComma, -1, value.length)
          pval = value.slice(i, stop).trim()
          i = stop
        }
        if (name === "rel" && !rel) rel = pval
      }
    }

    if (rel) {
      // A rel can be a space-separated list — store each so callers can ask
      // for any one of them.
      for (const r of rel.split(/\s+/)) {
        if (r && !(r in out)) out[r] = url
      }
    }
  }
  return out
}

function nextStop(...candidates: number[]): number {
  let best = Infinity
  for (const c of candidates) {
    if (c >= 0 && c < best) best = c
  }
  return best === Infinity ? (candidates[candidates.length - 1] ?? 0) : best
}

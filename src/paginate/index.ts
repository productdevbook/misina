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
export async function* paginate<T = unknown, R = unknown>(
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

function parseLinkHeader(value: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of value.split(",")) {
    const match = /<([^>]+)>;\s*rel="?([^",]+)"?/.exec(part.trim())
    if (match) {
      const url = match[1]
      const rel = match[2]
      if (url && rel) out[rel] = url
    }
  }
  return out
}

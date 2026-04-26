/**
 * Fire-and-forget delivery for telemetry/analytics. Tries (in order):
 *
 *   1. `fetchLater()` — WICG Pending Beacon API, Chromium 135+. Deferred
 *      delivery; the browser sends the request even if the page unloads.
 *   2. `fetch(url, { keepalive: true })` — survives unload up to 64 KiB
 *      total in-flight per origin. Errors visible if you await the promise.
 *   3. `navigator.sendBeacon(url, body)` — same 64 KiB cap, POST-only,
 *      no response.
 *
 * Browser-only — no Node fallback. The first available primitive wins.
 *
 * @example
 * ```ts
 * import { beacon } from "misina/beacon"
 *
 * beacon("/telemetry", { event: "page_view", ts: Date.now() })
 * ```
 */

export interface BeaconOptions {
  /** HTTP method. Default: 'POST'. sendBeacon ignores this and always POSTs. */
  method?: string
  /** Headers. Note: sendBeacon ignores headers entirely. */
  headers?: Record<string, string>
  /**
   * Earliest delivery time in ms relative to now. Honored by fetchLater
   * only; falls through to immediate dispatch on the other backends.
   */
  activateAfter?: number
}

export type BeaconResult =
  | { ok: true; via: "fetchLater" | "fetch-keepalive" | "sendBeacon" }
  | { ok: false; reason: "no-backend" | "send-rejected" }

export function beacon(
  url: string,
  body: BodyInit | Record<string, unknown> | undefined,
  options: BeaconOptions = {},
): BeaconResult {
  const method = options.method ?? "POST"
  const headers = options.headers ?? {}
  const init: RequestInit & { activateAfter?: number } = {
    method,
    headers,
    body: serialize(body, headers),
    keepalive: true,
  }

  // 1. fetchLater (Chromium-only, behind feature detection).
  type FetchLater = (
    input: string | URL,
    init?: RequestInit & { activateAfter?: number },
  ) => unknown
  const g = globalThis as { fetchLater?: FetchLater }
  if (typeof g.fetchLater === "function") {
    if (options.activateAfter !== undefined) init.activateAfter = options.activateAfter
    try {
      g.fetchLater(url, init)
      return { ok: true, via: "fetchLater" }
    } catch {
      // fall through to next backend
    }
  }

  // 2. fetch with keepalive — broadly supported, survives unload up to
  // 64 KiB. We don't await: telemetry must not block the caller.
  if (typeof fetch === "function") {
    try {
      // Mark the dangling promise as handled so a runtime warning doesn't
      // fire when the page unloads mid-flight.
      void fetch(url, init).catch(() => {})
      return { ok: true, via: "fetch-keepalive" }
    } catch {
      // fall through
    }
  }

  // 3. navigator.sendBeacon — last resort, POST-only, no headers.
  type SendBeacon = (url: string, body?: BodyInit) => boolean
  const nav = (globalThis as { navigator?: { sendBeacon?: SendBeacon } }).navigator
  if (nav?.sendBeacon) {
    const sent = nav.sendBeacon(url, init.body ?? undefined)
    return sent ? { ok: true, via: "sendBeacon" } : { ok: false, reason: "send-rejected" }
  }

  return { ok: false, reason: "no-backend" }
}

function serialize(
  body: BodyInit | Record<string, unknown> | undefined,
  headers: Record<string, string>,
): BodyInit | null {
  if (body == null) return null
  if (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof ReadableStream
  ) {
    return body as BodyInit
  }
  // Plain object → JSON.
  if (!hasContentType(headers)) headers["content-type"] = "application/json"
  return JSON.stringify(body)
}

function hasContentType(headers: Record<string, string>): boolean {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return true
  }
  return false
}

/**
 * W3C Trace Context propagation for misina. Auto-injects `traceparent`
 * and forwards `tracestate` on every outgoing request. Pure JS using
 * `crypto.getRandomValues` (Web Crypto, available everywhere).
 *
 * - L1 spec: https://www.w3.org/TR/trace-context/
 * - L2 spec: https://www.w3.org/TR/trace-context-2/
 *
 * Compose with OpenTelemetry by passing `getCurrentSpan` so misina pulls
 * the active span context instead of generating a fresh root.
 *
 * @example
 * ```ts
 * import { withTracing } from 'misina/tracing'
 *
 * const api = withTracing(createMisina({ baseURL }))
 * await api.get('/users/42') // request gets a fresh traceparent + matching tracestate
 *
 * // With OpenTelemetry:
 * import { trace } from '@opentelemetry/api'
 * const api2 = withTracing(misina, {
 *   getCurrentSpan: () => {
 *     const span = trace.getActiveSpan()
 *     return span ? { traceId: span.spanContext().traceId, parentId: span.spanContext().spanId } : null
 *   },
 * })
 * ```
 */

import type { Misina } from "../types.ts"

export interface TracingOptions {
  /**
   * Pull the parent span context from an external tracing system. Return
   * `null` to fall back to a freshly-generated root span. The returned
   * `traceId` must be 32 hex chars; `parentId` 16. `flags` is an integer
   * 0-255; `state` is the W3C tracestate header value.
   */
  getCurrentSpan?: () => TraceSpanContext | null
  /**
   * Static or dynamic baggage entries appended to the W3C `Baggage`
   * header. https://www.w3.org/TR/baggage/
   */
  baggage?: Record<string, string> | (() => Record<string, string>)
  /** Override traceparent flags (default: 01 — sampled). */
  flags?: number
}

export interface TraceSpanContext {
  traceId: string
  parentId: string
  flags?: number
  state?: string
}

const HEX = "0123456789abcdef"

function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount)
  crypto.getRandomValues(buf)
  let out = ""
  for (let i = 0; i < byteCount; i++) {
    const b = buf[i]!
    out += HEX[b >>> 4]
    out += HEX[b & 0x0f]
  }
  return out
}

function formatTraceparent(traceId: string, parentId: string, flags: number): string {
  const f = flags & 0xff
  return `00-${traceId}-${parentId}-${HEX[f >>> 4]}${HEX[f & 0x0f]}`
}

function buildBaggage(entries: Record<string, string>): string | null {
  const parts: string[] = []
  for (const [k, v] of Object.entries(entries)) {
    if (k === "" || v === "") continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return parts.length === 0 ? null : parts.join(",")
}

export function withTracing(misina: Misina, options: TracingOptions = {}): Misina {
  const flagsDefault = options.flags ?? 0x01
  return misina.extend({
    hooks: {
      beforeRequest: (ctx) => {
        // Don't overwrite a caller-supplied traceparent — they may have
        // their own propagator already wired in.
        const headers = new Headers(ctx.request.headers)
        if (!headers.has("traceparent")) {
          const span = options.getCurrentSpan?.() ?? null
          const traceId = span?.traceId ?? randomHex(16)
          const parentId = span?.parentId ?? randomHex(8)
          const flags = span?.flags ?? flagsDefault
          headers.set("traceparent", formatTraceparent(traceId, parentId, flags))
          if (span?.state && !headers.has("tracestate")) {
            headers.set("tracestate", span.state)
          }
        }
        if (options.baggage && !headers.has("baggage")) {
          const entries =
            typeof options.baggage === "function" ? options.baggage() : options.baggage
          const value = buildBaggage(entries)
          if (value) headers.set("baggage", value)
        }
        return new Request(ctx.request, { headers })
      },
    },
  })
}

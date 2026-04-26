/**
 * OpenTelemetry adapter — emits HTTP client spans for every misina
 * request with the standard `http.*` / `url.*` / `network.*` semantic
 * conventions.
 *
 * Peer-dep duck-typed: pass anything that satisfies the minimal
 * `Tracer` shape (`@opentelemetry/api`'s real Tracer fits, an in-memory
 * fake fits, your own wrapper fits). Lets users opt into spans without
 * misina ever importing `@opentelemetry/*`.
 *
 * Complements `misina/tracing`: `tracing()` is the W3C trace context
 * *propagator* (sets `traceparent` / `baggage`); `otel()` is the
 * *span emitter* (creates and ends spans, attaches semconv attributes,
 * records exceptions). Use one, the other, or both.
 *
 * @example
 * ```ts
 * import { trace } from "@opentelemetry/api"
 * import { createMisina } from "misina"
 * import { otel } from "misina/otel"
 *
 * const api = createMisina({
 *   baseURL,
 *   use: [otel({ tracer: trace.getTracer("my-service") })],
 * })
 * ```
 */

import type { MisinaPlugin } from "../types.ts"

/** Minimal SpanContext shape used to format `traceparent`. */
export interface OtelSpanContext {
  traceId: string
  spanId: string
  traceFlags: number
}

/** Minimal Span surface used by the adapter. */
export interface OtelSpan {
  setAttribute: (key: string, value: string | number | boolean) => void
  setStatus: (status: { code: number; message?: string }) => void
  recordException: (error: unknown) => void
  spanContext: () => OtelSpanContext
  end: () => void
}

/** Minimal Tracer surface — `tracer.startSpan(name, opts?)` is enough. */
export interface OtelTracer {
  startSpan: (
    name: string,
    options?: { attributes?: Record<string, string | number | boolean>; kind?: number },
  ) => OtelSpan
}

export interface OtelOptions {
  tracer: OtelTracer
  /**
   * Override the span name. Default: `HTTP <METHOD>` per the OTel
   * semantic conventions for HTTP client spans.
   */
  spanName?: (request: Request) => string
  /**
   * Inject `traceparent` based on the active span's context. Default:
   * true. Set false when the propagator (e.g. `withTracing`) is
   * already in the chain to avoid double-injection.
   */
  injectTraceparent?: boolean
  /** Extra attributes to add on every span. */
  attributes?: Record<string, string | number | boolean>
}

// SpanKind.CLIENT per OTel API spec — 2 (avoid importing the enum).
const SPAN_KIND_CLIENT = 2

// SpanStatusCode — 0 unset, 1 ok, 2 error.
const STATUS_ERROR = 2

/**
 * Plugin that emits OpenTelemetry HTTP client spans. One span per request
 * lifetime: started in `beforeRequest`, ended in `onComplete`. The span is
 * associated with the live `Request` via a WeakMap so we survive
 * `extend()` chains and per-request hook copies.
 */
export function otel(options: OtelOptions): MisinaPlugin {
  const inject = options.injectTraceparent ?? true
  const spans = new WeakMap<Request, OtelSpan>()
  const nameOf = options.spanName ?? ((req) => `HTTP ${req.method}`)

  return {
    name: "otel",
    hooks: {
      beforeRequest: (ctx) => {
        const url = new URL(ctx.request.url)
        const span = options.tracer.startSpan(nameOf(ctx.request), {
          kind: SPAN_KIND_CLIENT,
          attributes: {
            "http.request.method": ctx.request.method,
            "url.full": ctx.request.url,
            "url.scheme": url.protocol.replace(":", ""),
            "server.address": url.hostname,
            ...(url.port ? { "server.port": Number(url.port) } : {}),
            "network.protocol.name": "http",
            ...options.attributes,
          },
        })

        if (!inject) {
          spans.set(ctx.request, span)
          return
        }
        const sc = span.spanContext()
        const headers = new Headers(ctx.request.headers)
        if (!headers.has("traceparent")) {
          headers.set("traceparent", formatTraceparent(sc))
        }
        const next = new Request(ctx.request, { headers })
        spans.set(next, span)
        return next
      },
      onComplete: ({ request, response, error }) => {
        const span = spans.get(request)
        if (!span) return
        spans.delete(request)
        if (response) {
          span.setAttribute("http.response.status_code", response.status)
        }
        if (error) {
          span.recordException(error)
          span.setStatus({
            code: STATUS_ERROR,
            message: (error as { message?: string }).message ?? String(error),
          })
        }
        span.end()
      },
    },
  }
}

function formatTraceparent(sc: OtelSpanContext): string {
  // traceparent = 00-<trace-id>-<span-id>-<flags>
  // SpanContext.traceFlags is a number; OTel uses the lower byte.
  const flags = (sc.traceFlags & 0xff).toString(16).padStart(2, "0")
  return `00-${sc.traceId}-${sc.spanId}-${flags}`
}

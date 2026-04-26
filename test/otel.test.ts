import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { withOtel, type OtelSpan, type OtelTracer } from "../src/otel/index.ts"

interface RecordedSpan {
  name: string
  attributes: Record<string, string | number | boolean>
  status?: { code: number; message?: string }
  exceptions: unknown[]
  ended: boolean
  spanContext: { traceId: string; spanId: string; traceFlags: number }
  kind?: number
}

function fakeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  const tracer: OtelTracer = {
    startSpan: (name, opts) => {
      // Random-but-valid IDs (16 hex for trace, 16 hex for span).
      const sc = {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: `b0000000000000${(spans.length + 1).toString(16).padStart(2, "0")}`,
        traceFlags: 1,
      }
      const recorded: RecordedSpan = {
        name,
        attributes: { ...(opts?.attributes ?? {}) },
        exceptions: [],
        ended: false,
        spanContext: sc,
        kind: opts?.kind,
      }
      spans.push(recorded)
      const span: OtelSpan = {
        setAttribute: (k, v) => {
          recorded.attributes[k] = v
        },
        setStatus: (s) => {
          recorded.status = s
        },
        recordException: (e) => recorded.exceptions.push(e),
        spanContext: () => sc,
        end: () => {
          recorded.ended = true
        },
      }
      return span
    },
  }
  return { tracer, spans }
}

describe("withOtel — span lifecycle", () => {
  it("creates one CLIENT span per request with semconv attributes and ends it on success", async () => {
    const { tracer, spans } = fakeTracer()
    const driver = {
      name: "x",
      request: async () => new Response("{}", { status: 200 }),
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    await m.get("https://api.example.com:8443/users/42")
    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.name).toBe("HTTP GET")
    expect(s.kind).toBe(2) // SpanKind.CLIENT
    expect(s.attributes["http.request.method"]).toBe("GET")
    expect(s.attributes["url.full"]).toBe("https://api.example.com:8443/users/42")
    expect(s.attributes["url.scheme"]).toBe("https")
    expect(s.attributes["server.address"]).toBe("api.example.com")
    expect(s.attributes["server.port"]).toBe(8443)
    expect(s.attributes["http.response.status_code"]).toBe(200)
    expect(s.ended).toBe(true)
    expect(s.status).toBeUndefined() // success leaves status unset
    expect(s.exceptions).toEqual([])
  })

  it("records exception + sets ERROR status on HTTPError", async () => {
    const { tracer, spans } = fakeTracer()
    const driver = {
      name: "x",
      request: async () => new Response("nope", { status: 500 }),
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    await expect(m.get("https://api.example.com/")).rejects.toBeDefined()
    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.attributes["http.response.status_code"]).toBe(500)
    expect(s.exceptions).toHaveLength(1)
    expect(s.status?.code).toBe(2) // ERROR
    expect(s.ended).toBe(true)
  })

  it("records exception + status on NetworkError", async () => {
    const { tracer, spans } = fakeTracer()
    const driver = {
      name: "x",
      request: async () => {
        throw new TypeError("fetch failed")
      },
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    await expect(m.get("https://api.example.com/")).rejects.toBeDefined()
    expect(spans[0]?.status?.code).toBe(2)
    expect(spans[0]?.exceptions).toHaveLength(1)
    expect(spans[0]?.attributes["http.response.status_code"]).toBeUndefined()
  })

  it("injects traceparent built from the active span context", async () => {
    const { tracer, spans } = fakeTracer()
    let observedTp: string | null = null
    const driver = {
      name: "x",
      request: async (req: Request) => {
        observedTp = req.headers.get("traceparent")
        return new Response("ok", { status: 200 })
      },
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    await m.get("https://api.example.com/")
    expect(observedTp).toBe(
      `00-${spans[0]?.spanContext.traceId}-${spans[0]?.spanContext.spanId}-01`,
    )
  })

  it("does not overwrite a caller-provided traceparent", async () => {
    const { tracer } = fakeTracer()
    let observedTp: string | null = null
    const driver = {
      name: "x",
      request: async (req: Request) => {
        observedTp = req.headers.get("traceparent")
        return new Response("ok", { status: 200 })
      },
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    const tp = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
    await m.get("https://api.example.com/", { headers: { traceparent: tp } })
    expect(observedTp).toBe(tp)
  })

  it("injectTraceparent: false skips header injection", async () => {
    const { tracer } = fakeTracer()
    let observedTp: string | null = null
    const driver = {
      name: "x",
      request: async (req: Request) => {
        observedTp = req.headers.get("traceparent")
        return new Response("ok", { status: 200 })
      },
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), {
      tracer,
      injectTraceparent: false,
    })
    await m.get("https://api.example.com/")
    expect(observedTp).toBeNull()
  })

  it("custom spanName + extra attributes are honored", async () => {
    const { tracer, spans } = fakeTracer()
    const driver = {
      name: "x",
      request: async () => new Response("ok", { status: 200 }),
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), {
      tracer,
      spanName: (req) => `http.${req.method.toLowerCase()} ${new URL(req.url).pathname}`,
      attributes: { "deployment.environment": "test" },
    })
    await m.get("https://api.example.com/users/42")
    expect(spans[0]?.name).toBe("http.get /users/42")
    expect(spans[0]?.attributes["deployment.environment"]).toBe("test")
  })

  it("each request gets its own span (no leakage across calls)", async () => {
    const { tracer, spans } = fakeTracer()
    const driver = {
      name: "x",
      request: async () => new Response("ok", { status: 200 }),
    }
    const m = withOtel(createMisina({ driver, retry: 0 }), { tracer })
    await Promise.all([
      m.get("https://api.example.com/a"),
      m.get("https://api.example.com/b"),
      m.get("https://api.example.com/c"),
    ])
    expect(spans).toHaveLength(3)
    expect(spans.every((s) => s.ended)).toBe(true)
    const urls = spans.map((s) => s.attributes["url.full"]).sort()
    expect(urls).toEqual([
      "https://api.example.com/a",
      "https://api.example.com/b",
      "https://api.example.com/c",
    ])
  })
})

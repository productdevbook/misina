import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

const noopDriver = {
  name: "noop",
  request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
}

describe("hook ctx — request.headers is always a Headers instance (undici#4336)", () => {
  it("plain object headers normalize to Headers in beforeRequest ctx", async () => {
    let observed: unknown
    const m = createMisina({
      driver: noopDriver,
      retry: 0,
      headers: { "x-foo": "bar" },
      hooks: {
        beforeRequest: (ctx) => {
          observed = ctx.request.headers
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBeInstanceOf(Headers)
    expect((observed as Headers).get("x-foo")).toBe("bar")
  })

  it("array of pairs normalizes to Headers", async () => {
    let observed: unknown
    const m = createMisina({
      driver: noopDriver,
      retry: 0,
      headers: [
        ["x-foo", "v1"],
        ["x-bar", "v2"],
      ],
      hooks: {
        beforeRequest: (ctx) => {
          observed = ctx.request.headers
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBeInstanceOf(Headers)
    expect((observed as Headers).get("x-foo")).toBe("v1")
    expect((observed as Headers).get("x-bar")).toBe("v2")
  })

  it("Headers instance is preserved", async () => {
    let observed: unknown
    const m = createMisina({
      driver: noopDriver,
      retry: 0,
      headers: new Headers({ "x-foo": "bar" }),
      hooks: {
        beforeRequest: (ctx) => {
          observed = ctx.request.headers
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBeInstanceOf(Headers)
    expect((observed as Headers).get("x-foo")).toBe("bar")
  })

  it("afterResponse ctx also exposes Headers instance", async () => {
    let observed: unknown
    const m = createMisina({
      driver: noopDriver,
      retry: 0,
      hooks: {
        afterResponse: (ctx) => {
          observed = ctx.request.headers
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBeInstanceOf(Headers)
  })

  it("beforeRetry ctx also exposes Headers instance", async () => {
    let attempts = 0
    let observed: unknown
    const driver = {
      name: "x",
      request: async () => {
        attempts++
        if (attempts === 1) return new Response("err", { status: 503 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, statusCodes: [503], delay: () => 0 },
      hooks: {
        beforeRetry: (ctx) => {
          observed = ctx.request.headers
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBeInstanceOf(Headers)
  })

  it("hook can mutate via new Request — change is visible to subsequent hooks", async () => {
    const seen: { phase: string; v: string | null }[] = []
    const m = createMisina({
      driver: {
        name: "x",
        request: async (req) => {
          seen.push({ phase: "driver", v: req.headers.get("x-foo") })
          return new Response("{}", { headers: { "content-type": "application/json" } })
        },
      },
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          seen.push({ phase: "before", v: ctx.request.headers.get("x-foo") })
          const h = new Headers(ctx.request.headers)
          h.set("x-foo", "mutated")
          return new Request(ctx.request, { headers: h })
        },
        afterResponse: (ctx) => {
          seen.push({ phase: "after", v: ctx.request.headers.get("x-foo") })
        },
      },
    })
    await m.get("https://x.test/")
    expect(seen.find((s) => s.phase === "before")?.v).toBeNull()
    expect(seen.find((s) => s.phase === "driver")?.v).toBe("mutated")
    expect(seen.find((s) => s.phase === "after")?.v).toBe("mutated")
  })
})

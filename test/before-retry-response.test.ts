import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("beforeRetry — return Response to short-circuit", () => {
  it("hook returning Response stops retries and finalizes that response", async () => {
    let calls = 0
    const driver = {
      name: "always-fail",
      request: async () => {
        calls++
        return new Response("upstream-down", { status: 503 })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        beforeRetry: () =>
          new Response(JSON.stringify({ source: "cache", value: 42 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    })

    const res = await m.get<{ source: string; value: number }>("https://api.test/")
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ source: "cache", value: 42 })
    // First attempt + one retry attempt where the hook short-circuited.
    expect(calls).toBe(1)
  })

  it("hook returning Request still works (existing behavior preserved)", async () => {
    let calls = 0
    const seen: string[] = []
    const driver = {
      name: "fallback-host",
      request: async (req: Request) => {
        calls++
        seen.push(req.url)
        if (calls === 1) return new Response(null, { status: 503 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      hooks: {
        beforeRetry: () => new Request("https://fallback.test/"),
      },
    })

    await m.get("https://api.test/")
    expect(calls).toBe(2)
    expect(seen[0]).toBe("https://api.test/")
    expect(seen[1]).toBe("https://fallback.test/")
  })

  it("hook returning void/undefined: retry proceeds normally", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        if (calls < 2) return new Response(null, { status: 503 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 1 },
      hooks: {
        beforeRetry: () => undefined,
      },
    })

    const res = await m.get("https://api.test/")
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })

  it("multiple beforeRetry hooks: first to return Response wins, rest skipped", async () => {
    const order: string[] = []
    const driver = {
      name: "f",
      request: async () => {
        order.push("driver")
        return new Response(null, { status: 503 })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 1 },
      hooks: {
        beforeRetry: [
          () => {
            order.push("hook-1")
            return new Response('{"from":"hook-1"}', {
              headers: { "content-type": "application/json" },
            })
          },
          () => {
            order.push("hook-2")
          },
        ],
      },
    })

    const res = await m.get<{ from: string }>("https://api.test/")
    expect(res.data.from).toBe("hook-1")
    // Driver fires once; hook-1 short-circuits; hook-2 must not run.
    expect(order).toEqual(["driver", "hook-1"])
  })
})

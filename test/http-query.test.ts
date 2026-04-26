import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("misina.query — HTTP QUERY method", () => {
  it("sends a QUERY request with a JSON body", async () => {
    let captured: Request | undefined
    const driver = {
      name: "q",
      request: async (req: Request) => {
        captured = req
        return new Response('{"hits":[]}', {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.query("https://api.test/search", { filter: { age: { gte: 21 } } })

    expect(captured?.method).toBe("QUERY")
    expect(captured?.headers.get("content-type")).toBe("application/json")
    const body = await captured?.text()
    expect(body).toBe('{"filter":{"age":{"gte":21}}}')
  })

  it("QUERY is retried by default (treated as idempotent)", async () => {
    let attempts = 0
    const driver = {
      name: "flaky",
      request: async () => {
        attempts++
        if (attempts < 3) return new Response(null, { status: 503 })
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
    })

    await m.query("https://api.test/search", { q: "fish" })
    expect(attempts).toBe(3)
  })

  it("idempotencyKey: 'auto' does NOT set a key on QUERY (already idempotent)", async () => {
    let captured: Request | undefined
    const driver = {
      name: "q",
      request: async (req: Request) => {
        captured = req
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.query("https://api.test/search", { q: "fish" })
    expect(captured?.headers.get("idempotency-key")).toBeNull()
  })

  it("returns typed JSON response", async () => {
    const driver = {
      name: "q",
      request: async () =>
        new Response('{"hits":[1,2,3]}', {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const res = await m.query<{ hits: number[] }>("https://api.test/search", { q: "x" })
    expect(res.data.hits).toEqual([1, 2, 3])
  })
})

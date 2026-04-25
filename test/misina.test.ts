import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("misina", () => {
  it("performs a GET and parses JSON", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch

    const misina = createMisina({ fetch: fetchImpl })
    const res = await misina.get<{ ok: boolean }>("https://example.test/x")

    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
  })

  it("serializes JSON bodies on POST", async () => {
    let captured: RequestInit | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const misina = createMisina({ fetch: fetchImpl })
    await misina.post("https://example.test/x", { a: 1 })

    expect(captured?.body).toBe(JSON.stringify({ a: 1 }))
    expect((captured?.headers as Record<string, string>)["content-type"]).toBe("application/json")
  })
})

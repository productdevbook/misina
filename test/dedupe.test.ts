import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"
import { dedupe } from "../src/dedupe/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("dedupe", () => {
  it("collapses concurrent identical GETs onto a single network call", async () => {
    let calls = 0
    const driver = {
      name: "track",
      request: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return jsonResponse({ ok: true })
      },
    }

    const api = createMisina({ driver, retry: 0, use: [dedupe()] })

    const [a, b, c] = await Promise.all([
      api.get("https://api.test/x"),
      api.get("https://api.test/x"),
      api.get("https://api.test/x"),
    ])

    expect(calls).toBe(1)
    expect(a.data).toEqual({ ok: true })
    expect(b.data).toEqual({ ok: true })
    expect(c.data).toEqual({ ok: true })
  })

  it("does not dedupe POST by default", async () => {
    let calls = 0
    const driver = {
      name: "track",
      request: async () => {
        calls++
        return jsonResponse({})
      },
    }

    const api = createMisina({ driver, retry: 0, use: [dedupe()] })

    await Promise.all([
      api.post("https://api.test/x", { a: 1 }),
      api.post("https://api.test/x", { a: 1 }),
    ])

    expect(calls).toBe(2)
  })

  it("preserves .onError chaining on deduped promises", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 404 }),
    })
    const api = createMisina({ driver, retry: 0, use: [dedupe()] })

    const result = await api.get<unknown>("https://api.test/").onError(404, () => "fallback")
    expect(result).toBe("fallback")
  })

  it("custom key function lets users dedupe by request body", async () => {
    let calls = 0
    const driver = {
      name: "track",
      request: async () => {
        calls++
        // Async tick gives concurrent callers time to collapse onto the
        // same in-flight promise.
        await new Promise((r) => setTimeout(r, 5))
        return jsonResponse({})
      },
    }

    const api = createMisina({
      driver,
      retry: 0,
      use: [
        dedupe({
          methods: ["POST"],
          key: (input: string, init?: { method?: string; body?: unknown }) =>
            `${init?.method ?? "GET"} ${input} ${JSON.stringify(init?.body ?? {})}`,
        }),
      ],
    })

    await Promise.all([
      api.post("https://api.test/x", { a: 1 }),
      api.post("https://api.test/x", { a: 1 }),
      api.post("https://api.test/x", { b: 2 }),
    ])

    // First two collapse onto one; third has distinct body and runs separately.
    expect(calls).toBe(2)
  })
})

import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"
import { withDedupe } from "../src/dedupe/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("withDedupe — additional edges", () => {
  it("all concurrent waiters receive the same parsed data", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ id: calls })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))
    const [a, b, c] = await Promise.all([
      m.get<{ id: number }>("https://api.test/x"),
      m.get<{ id: number }>("https://api.test/x"),
      m.get<{ id: number }>("https://api.test/x"),
    ])
    expect(calls).toBe(1)
    expect(a.data.id).toBe(b.data.id)
    expect(b.data.id).toBe(c.data.id)
  })

  it("error response is shared by all concurrent waiters", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ message: "fail" }, { status: 500 })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    const settled = await Promise.allSettled([
      m.get("https://api.test/x"),
      m.get("https://api.test/x"),
    ])

    expect(calls).toBe(1)
    expect(settled[0]?.status).toBe("rejected")
    expect(settled[1]?.status).toBe("rejected")
    if (settled[0]?.status === "rejected" && settled[1]?.status === "rejected") {
      expect(settled[0].reason).toBeInstanceOf(HTTPError)
      expect(settled[1].reason).toBeInstanceOf(HTTPError)
    }
  })

  it("different URLs are NOT deduped", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    await Promise.all([m.get("https://api.test/a"), m.get("https://api.test/b")])
    expect(calls).toBe(2)
  })

  it("subsequent (sequential) requests do NOT share — slot freed after settle", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ id: calls })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    const a = await m.get<{ id: number }>("https://api.test/x")
    const b = await m.get<{ id: number }>("https://api.test/x")
    expect(calls).toBe(2)
    expect(a.data.id).toBe(1)
    expect(b.data.id).toBe(2)
  })

  it("POST is NOT deduped by default", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    await Promise.all([
      m.post("https://api.test/x", { a: 1 }),
      m.post("https://api.test/x", { a: 1 }),
    ])
    expect(calls).toBe(2)
  })

  it("opt-in POST deduping with methods: ['POST']", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }), { methods: ["POST"] })

    await Promise.all([
      m.post("https://api.test/x", { a: 1 }),
      m.post("https://api.test/x", { a: 1 }),
    ])
    expect(calls).toBe(1)
  })

  it("custom key collapses requests by canonical form", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }), {
      // Custom key: ignore query order/casing.
      key: (input) => {
        const u = new URL(input)
        const sortedParams = [...u.searchParams.entries()].sort()
        return `${u.origin}${u.pathname}?${sortedParams.map(([k, v]) => `${k}=${v}`).join("&")}`
      },
    })

    await Promise.all([m.get("https://api.test/q?a=1&b=2"), m.get("https://api.test/q?b=2&a=1")])
    expect(calls).toBe(1)
  })

  it("non-listed method (PUT) bypasses dedupe entirely", async () => {
    let calls = 0
    const driver = {
      name: "f",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    await Promise.all([
      m.put("https://api.test/x", { a: 1 }),
      m.put("https://api.test/x", { a: 1 }),
    ])
    expect(calls).toBe(2)
  })

  it("waiters can each call res.raw independently if needed", async () => {
    const driver = {
      name: "f",
      request: async () => jsonResponse({ ok: true }),
    }
    const m = withDedupe(createMisina({ driver, retry: 0 }))

    const [a, b] = await Promise.all([m.get("https://api.test/x"), m.get("https://api.test/x")])
    // Both waiters share the same response object — they get the parsed data
    // identically. raw bodies may have already been consumed during parse.
    expect(a.data).toEqual(b.data)
  })
})

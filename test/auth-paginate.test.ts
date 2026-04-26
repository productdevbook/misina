import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { refreshOn401 } from "../src/auth/index.ts"
import { paginate } from "../src/paginate/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("refreshOn401 — race + recursion (Bug 47)", () => {
  it("collapses concurrent 401s onto a single refresh call", async () => {
    let refreshCount = 0
    let token = "old"

    const driver = {
      name: "track",
      request: async (req: Request) => {
        const auth = req.headers.get("authorization")
        if (auth === "Bearer old") return new Response(null, { status: 401 })
        return jsonResponse({ ok: true })
      },
    }

    const api = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          const headers = new Headers(ctx.request.headers)
          headers.set("authorization", `Bearer ${token}`)
          return new Request(ctx.request, { headers })
        },
      },
      use: [
        refreshOn401({
          refresh: async () => {
            refreshCount++
            await new Promise((r) => setTimeout(r, 10))
            token = "new"
            return token
          },
        }),
      ],
    })

    await Promise.all([
      api.get("https://api.test/a"),
      api.get("https://api.test/b"),
      api.get("https://api.test/c"),
    ])

    expect(refreshCount).toBe(1)
  })

  it("does NOT loop forever when the refreshed token is also rejected", async () => {
    let attempts = 0

    const driver = {
      name: "always-401",
      request: async () => {
        attempts++
        return new Response(null, { status: 401 })
      },
    }

    const api = createMisina({
      driver,
      retry: 0,
      throwHttpErrors: false,
      use: [refreshOn401({ refresh: async () => "new-but-still-bad" })],
    })

    const res = await api.get("https://api.test/x")
    expect(res.status).toBe(401)
    // First attempt + one refresh retry. Without the loop guard we'd see
    // many more.
    expect(attempts).toBe(2)
  })

  it("does not leak the marker header to the network", async () => {
    let sawMarker = false
    const driver = {
      name: "watcher",
      request: async (req: Request) => {
        if (req.headers.has("x-misina-refreshed")) sawMarker = true
        return new Response(null, { status: 401 })
      },
    }

    const api = createMisina({
      driver,
      retry: 0,
      throwHttpErrors: false,
      use: [refreshOn401({ refresh: async () => "new" })],
    })

    await api.get("https://api.test/x")
    expect(sawMarker).toBe(false)
  })
})

describe("paginate — cycle detection (Bug 49)", () => {
  it("stops when the next callback returns the same URL", async () => {
    let calls = 0
    const driver = {
      name: "loopy",
      request: async () => {
        calls++
        return jsonResponse([{ id: calls }])
      },
    }

    const m = createMisina({ driver, retry: 0 })

    const items: unknown[] = []
    for await (const item of paginate(m, "https://api.test/items", {
      next: () => ({ url: "https://api.test/items" }), // points back to itself
    })) {
      items.push(item)
    }

    // First call yielded its item, then cycle detected and we stop before
    // the second network call.
    expect(calls).toBe(1)
    expect(items).toHaveLength(1)
  })
})

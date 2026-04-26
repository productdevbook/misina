import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"
import type { CompletionContext } from "../src/types.ts"

describe("onComplete — terminal lifecycle hook", () => {
  it("fires once on success", async () => {
    const events: CompletionContext[] = []
    const driver = {
      name: "p",
      request: async () =>
        new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: (info) => {
          events.push(info)
        },
      },
    })

    await m.get("https://api.test/")
    expect(events).toHaveLength(1)
    expect(events[0]?.response?.status).toBe(200)
    expect(events[0]?.error).toBeUndefined()
    expect(events[0]?.attempt).toBe(0)
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("fires once on HTTPError", async () => {
    const events: CompletionContext[] = []
    const driver = {
      name: "p",
      request: async () => new Response("bad", { status: 500 }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: (info) => {
          events.push(info)
        },
      },
    })

    await m.get("https://api.test/").catch(() => {})
    expect(events).toHaveLength(1)
    expect(events[0]?.error).toBeInstanceOf(HTTPError)
    expect(events[0]?.response?.status).toBe(500)
  })

  it("fires once on NetworkError", async () => {
    const events: CompletionContext[] = []
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: (info) => {
          events.push(info)
        },
      },
    })

    await m.get("https://api.test/").catch(() => {})
    expect(events).toHaveLength(1)
    expect(events[0]?.error?.name).toBe("NetworkError")
    expect(events[0]?.response).toBeUndefined()
  })

  it("fires ONCE even after retries (terminal-only)", async () => {
    const events: CompletionContext[] = []
    let calls = 0
    const driver = {
      name: "flaky",
      request: async () => {
        calls++
        if (calls < 3) return new Response(null, { status: 503 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        onComplete: (info) => {
          events.push(info)
        },
      },
    })

    await m.get("https://api.test/")
    expect(events).toHaveLength(1)
    expect(events[0]?.attempt).toBe(2) // 0, 1, 2 — third attempt
    expect(events[0]?.response?.status).toBe(200)
  })

  it("includes durationMs > 0", async () => {
    const events: CompletionContext[] = []
    const driver = {
      name: "slow",
      request: async () => {
        await new Promise((r) => setTimeout(r, 10))
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: (info) => {
          events.push(info)
        },
      },
    })

    await m.get("https://api.test/")
    expect(events[0]?.durationMs).toBeGreaterThan(5)
  })

  it("multiple hooks all fire in order", async () => {
    const order: string[] = []
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: [
          () => {
            order.push("default")
          },
        ],
      },
    })

    await m.get("https://api.test/", {
      hooks: {
        onComplete: [
          () => {
            order.push("per-request")
          },
        ],
      },
    })
    expect(order).toEqual(["default", "per-request"])
  })

  it("ctx.options.meta reachable in onComplete", async () => {
    let captured: unknown
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        onComplete: (info) => {
          captured = info.options.meta
        },
      },
    })

    await m.get("https://api.test/", { meta: { tag: "search" } as Record<string, unknown> })
    expect(captured).toEqual({ tag: "search" })
  })
})

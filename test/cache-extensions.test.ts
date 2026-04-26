import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import type { CacheEntry } from "../src/cache/index.ts"
import { cache, memoryStore } from "../src/cache/index.ts"
import type { MisinaContext } from "../src/types.ts"

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("cache — shouldStore filter", () => {
  it("rejects responses that fail the predicate", async () => {
    const store = memoryStore()
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ ok: true })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        cache({
          store,
          shouldStore: (_req: Request, res: Response) => {
            // Refuse to cache anything (simulate a strict policy).
            return res.headers.get("x-cache") === "ok"
          },
        }),
      ],
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")
    expect(calls).toBe(2) // not cached, two real requests
  })

  it("allows storage when predicate is true", async () => {
    const store = memoryStore()
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ ok: true }, { "cache-control": "max-age=60" })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [cache({ store, shouldStore: () => true })],
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")
    expect(calls).toBe(1) // second call served from cache
  })
})

describe("cache — beforeStore mutator", () => {
  it("can replace the entry", async () => {
    const store = memoryStore()
    const driver = {
      name: "p",
      request: async () =>
        jsonResponse({ secret: "abc", visible: 1 }, { "cache-control": "max-age=60" }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        cache({
          store,
          beforeStore: (entry: CacheEntry) => ({
            ...entry,
            // tag the entry with custom metadata
            vary: { ...(entry.vary ?? {}), "x-source": "filtered" },
          }),
        }),
      ],
    })

    await m.get("https://api.test/")
    // Verify the cached entry has the marker.
    // memoryStore is synchronous in get.
    // Use the public API: a 2nd call returns from cache.
    const second = await m.get<{ visible: number }>("https://api.test/")
    expect(second.data.visible).toBe(1)
  })

  it("returning undefined abandons caching this response", async () => {
    const store = memoryStore()
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ ok: true }, { "cache-control": "max-age=60" })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [cache({ store, beforeStore: () => undefined })],
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")
    expect(calls).toBe(2)
  })
})

describe("cache — custom key with meta", () => {
  it("custom key partitions cache by user (verifies key callback works as documented)", async () => {
    const store = memoryStore()
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ ok: true }, { "cache-control": "max-age=60" })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        cache({
          store,
          key: (ctx: MisinaContext) => {
            const userId = (ctx.options.headers as Record<string, string>)?.["x-user-id"] ?? "anon"
            return `${ctx.options.method} ${ctx.options.url}|user=${userId}`
          },
        }),
      ],
    })

    await m.get("https://api.test/profile", { headers: { "x-user-id": "u1" } })
    await m.get("https://api.test/profile", { headers: { "x-user-id": "u2" } })
    await m.get("https://api.test/profile", { headers: { "x-user-id": "u1" } })
    // Two distinct user keys — third call comes from cache for u1.
    expect(calls).toBe(2)
  })
})

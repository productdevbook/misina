import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { cache, memoryStore } from "../src/cache/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("cache — RFC 9111 compliance", () => {
  it("Cache-Control: no-store is honored (response not stored)", async () => {
    let calls = 0
    const driver = {
      name: "ns",
      request: async () => {
        calls++
        return jsonResponse(
          { count: calls },
          {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        )
      },
    }

    const store = memoryStore()
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 60_000 })] })

    await m.get("https://api.test/")
    await m.get("https://api.test/")

    // No store, so both calls hit network.
    expect(calls).toBe(2)
  })

  it("Cache-Control: max-age overrides local ttl", async () => {
    let calls = 0
    const driver = {
      name: "served",
      request: async () => {
        calls++
        return jsonResponse(
          { x: 1 },
          {
            headers: {
              "content-type": "application/json",
              // 1 second max-age — well under the local ttl of 60s
              "cache-control": "max-age=1",
            },
          },
        )
      },
    }

    const store = memoryStore()
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 60_000 })] })

    await m.get("https://api.test/")
    expect(calls).toBe(1)

    // Wait past the server-controlled max-age but well within local ttl.
    await new Promise((r) => setTimeout(r, 1100))

    await m.get("https://api.test/")
    expect(calls).toBe(2)
  })

  it("Vary header — different request headers bust the cache", async () => {
    let calls = 0
    const driver = {
      name: "vary",
      request: async (req: Request) => {
        calls++
        return jsonResponse(
          { lang: req.headers.get("accept-language") },
          {
            headers: {
              "content-type": "application/json",
              vary: "Accept-Language",
            },
          },
        )
      },
    }

    const store = memoryStore()
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 60_000 })] })

    const en = await m.get<{ lang: string }>("https://api.test/", {
      headers: { "accept-language": "en" },
    })
    expect(en.data.lang).toBe("en")

    // Same URL, different Accept-Language — must not reuse the en cache.
    const tr = await m.get<{ lang: string }>("https://api.test/", {
      headers: { "accept-language": "tr" },
    })
    expect(tr.data.lang).toBe("tr")
    expect(calls).toBe(2)

    // But en again hits the cache.
    const en2 = await m.get<{ lang: string }>("https://api.test/", {
      headers: { "accept-language": "en" },
    })
    expect(en2.data.lang).toBe("en")
    expect(calls).toBe(2)
  })

  it("Vary: * forces revalidation every time", async () => {
    let calls = 0
    const driver = {
      name: "vary-star",
      request: async () => {
        calls++
        return jsonResponse(
          { x: 1 },
          {
            headers: {
              "content-type": "application/json",
              vary: "*",
            },
          },
        )
      },
    }

    const store = memoryStore()
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 60_000 })] })

    await m.get("https://api.test/")
    await m.get("https://api.test/")

    expect(calls).toBe(2)
  })
})

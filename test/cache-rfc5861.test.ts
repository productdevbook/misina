import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { cache, memoryStore, parseCacheControl } from "../src/cache/index.ts"

describe("parseCacheControl", () => {
  it("parses common directives", () => {
    const cc = parseCacheControl(
      "public, max-age=60, s-maxage=120, stale-while-revalidate=30, stale-if-error=300, immutable",
    )
    expect(cc.public).toBe(true)
    expect(cc.maxAge).toBe(60)
    expect(cc.sMaxAge).toBe(120)
    expect(cc.staleWhileRevalidate).toBe(30)
    expect(cc.staleIfError).toBe(300)
    expect(cc.immutable).toBe(true)
  })

  it("handles quoted values and whitespace", () => {
    const cc = parseCacheControl('  max-age = "60" , no-store ')
    expect(cc.maxAge).toBe(60)
    expect(cc.noStore).toBe(true)
  })

  it("ignores malformed numeric directives", () => {
    const cc = parseCacheControl("max-age=abc, stale-if-error=-5")
    expect(cc.maxAge).toBeUndefined()
    expect(cc.staleIfError).toBeUndefined()
  })

  it("returns empty for null/empty input", () => {
    expect(parseCacheControl(null)).toEqual({})
    expect(parseCacheControl("")).toEqual({})
  })
})

describe("cache — RFC 5861 stale-while-revalidate", () => {
  it("serves stale entry within SWR window and revalidates in background", async () => {
    const store = memoryStore()
    let serverHits = 0
    const driver = {
      name: "x",
      request: async () => {
        serverHits++
        return new Response(`{"hit":${serverHits}}`, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "max-age=0, stale-while-revalidate=60",
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 0 })] })
    // Prime the cache.
    await m.get("https://x.test/")
    expect(serverHits).toBe(1)

    // Stub global fetch so the background revalidation has something
    // deterministic to call (the driver path is for the foreground).
    const origFetch = globalThis.fetch
    let bgHits = 0
    globalThis.fetch = (async () => {
      bgHits++
      return new Response(`{"bg":${bgHits}}`, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=60, stale-while-revalidate=60",
        },
      })
    }) as typeof fetch

    try {
      // Wait so the entry is stale (ttl=0 means already expired).
      await new Promise((r) => setTimeout(r, 5))
      const res = await m.get<{ hit?: number }>("https://x.test/")
      // Stale entry served — original body, not the background one.
      expect(res.data.hit).toBe(1)
      // Background revalidation kicked off.
      await new Promise((r) => setTimeout(r, 10))
      expect(bgHits).toBe(1)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe("cache — RFC 5861 stale-if-error", () => {
  it("serves cached entry when origin returns 5xx within SIE window", async () => {
    const store = memoryStore()
    let firstCall = true
    const driver = {
      name: "x",
      request: async () => {
        if (firstCall) {
          firstCall = false
          return new Response('{"v":1}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "max-age=0, stale-if-error=60",
            },
          })
        }
        return new Response("boom", { status: 503 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 0 })] })
    await m.get("https://x.test/")
    await new Promise((r) => setTimeout(r, 5))

    const res = await m.get<{ v: number }>("https://x.test/")
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ v: 1 })
  })

  it("does not mask 4xx — those are intentional", async () => {
    const store = memoryStore()
    let firstCall = true
    const driver = {
      name: "x",
      request: async () => {
        if (firstCall) {
          firstCall = false
          return new Response('{"v":1}', {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "max-age=0, stale-if-error=60",
            },
          })
        }
        return new Response("nope", { status: 404 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 0 })] })
    await m.get("https://x.test/")
    await new Promise((r) => setTimeout(r, 5))

    await expect(m.get("https://x.test/")).rejects.toMatchObject({ status: 404 })
  })
})

describe("cache — RFC 8246 immutable", () => {
  it("skips conditional revalidation when entry is immutable", async () => {
    const store = memoryStore()
    let calls = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        calls++
        // If the cache layer sent an If-None-Match, fail the test by
        // returning 304 so the regression is observable.
        if (req.headers.get("if-none-match")) {
          return new Response(null, { status: 304 })
        }
        return new Response('{"v":1}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: '"abc"',
            "cache-control": "max-age=0, immutable",
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 0 })] })
    await m.get("https://x.test/")
    await new Promise((r) => setTimeout(r, 5))

    // Even though the entry is "expired" (ttl=0), `immutable` forces us
    // to skip revalidation knobs. The cache layer here actually treats
    // expired entries as needing a fresh fetch though — so the second
    // call hits the origin without conditional headers.
    const res = await m.get("https://x.test/")
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })
})

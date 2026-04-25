import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("URL encoding edges", () => {
  it("query values with spaces and special chars are %-encoded", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", {
      query: { q: "hello world", tag: "a&b" },
    })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("q")).toBe("hello world") // decoded back
    expect(url.searchParams.get("tag")).toBe("a&b")
  })

  it("absolute URL preserves trailing slash", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/users/")
    expect(getMockApi(driver)!.calls[0]!.url).toBe("https://api.test/users/")
  })

  it("baseURL without trailing slash + relative path", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/v1" })

    await m.get("users")
    expect(getMockApi(driver)!.calls[0]!.url).toBe("https://api.test/v1/users")
  })

  it("Unicode in path is %-encoded", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/türkçe")
    // Browser/Node both percent-encode non-ASCII path segments via WHATWG URL.
    expect(getMockApi(driver)!.calls[0]!.url).toMatch(/t%C3%BCrk%C3%A7e/)
  })
})

describe("retry — jitter and backoffLimit", () => {
  it("backoffLimit caps the delay", async () => {
    let attempts = 0
    const seenDelays: number[] = []
    let lastTs = Date.now()

    const driver = {
      name: "track",
      request: async () => {
        const now = Date.now()
        if (attempts > 0) seenDelays.push(now - lastTs)
        lastTs = now
        attempts++
        if (attempts < 3) return new Response("nope", { status: 503 })
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: {
        limit: 2,
        delay: () => 10_000, // would be 10s
        backoffLimit: 50, // capped to 50ms
      },
    })

    await m.get("https://api.test/")
    // Both delays should be capped near 50ms (allow generous slack).
    for (const d of seenDelays) {
      expect(d).toBeLessThan(500)
    }
  })

  it("jitter: true randomizes the delay (full jitter)", async () => {
    const baseDelay = 100
    const seen: number[] = []

    const driver = {
      name: "track",
      request: async () => {
        seen.push(Date.now())
        return seen.length < 4 ? new Response("nope", { status: 503 }) : jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => baseDelay, jitter: true },
    })

    await m.get("https://api.test/")
    // All retries should be <= base delay (full jitter halves it on average).
    for (let i = 1; i < seen.length; i++) {
      const delta = seen[i]! - seen[i - 1]!
      expect(delta).toBeLessThanOrEqual(baseDelay + 50) // small slack
    }
  })
})

describe("totalTimeout caps the wall-clock", () => {
  it("aborts even if individual attempts would have succeeded", async () => {
    const driver = {
      name: "always-slow",
      request: (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal!.reason), {
            once: true,
          })
        }),
    }

    const m = createMisina({
      driver,
      retry: 0,
      timeout: false,
      totalTimeout: 30,
    })

    const start = Date.now()
    await expect(m.get("https://api.test/")).rejects.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
  }, 3000)
})

describe("beforeRequest Response short-circuit", () => {
  it("does not call the driver when beforeRequest returns a Response", async () => {
    let driverCalls = 0
    const driver = {
      name: "watch",
      request: async () => {
        driverCalls++
        return jsonResponse({ never: true })
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: () =>
          new Response(JSON.stringify({ stub: 1 }), {
            headers: { "content-type": "application/json" },
          }),
      },
    })

    const res = await m.get<{ stub: number }>("https://api.test/")
    expect(res.data).toEqual({ stub: 1 })
    expect(driverCalls).toBe(0)
  })

  it("the short-circuit Response is parsed by responseType", async () => {
    const m = createMisina({
      driver: { name: "x", request: async () => new Response() },
      retry: 0,
      hooks: {
        beforeRequest: () =>
          new Response("plain text", { headers: { "content-type": "text/plain" } }),
      },
    })

    const res = await m.get<string>("https://api.test/", { responseType: "text" })
    expect(res.data).toBe("plain text")
  })
})

describe("hooks fired in order: init -> beforeRequest -> afterResponse -> beforeError", () => {
  it("init runs before beforeRequest, sees mutable options", async () => {
    const seen: string[] = []
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        init: () => seen.push("init"),
        beforeRequest: () => {
          seen.push("beforeRequest")
        },
        afterResponse: () => {
          seen.push("afterResponse")
        },
      },
    })

    await m.get("https://api.test/")
    expect(seen).toEqual(["init", "beforeRequest", "afterResponse"])
  })

  it("beforeError runs even when validateResponse rejects", async () => {
    const seen: string[] = []
    const driver = mockDriverFactory({ response: jsonResponse({ ok: false }) })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: () => false,
      hooks: {
        beforeError: (e) => {
          seen.push("beforeError")
          return e
        },
      },
    })

    await expect(m.get("https://api.test/")).rejects.toThrow()
    expect(seen).toEqual(["beforeError"])
  })
})

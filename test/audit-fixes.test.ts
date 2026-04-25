import { describe, expect, it } from "vitest"
import { createMisina, isHTTPError, isTimeoutError, replaceOption } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("audit pass 1 — Retry-After parsing (Bug 8)", () => {
  it("treats empty Retry-After as missing (no zero-second instant retry)", async () => {
    let attempt = 0
    const driver = {
      name: "track",
      request: async () => {
        attempt++
        if (attempt === 1) {
          return new Response(null, {
            status: 429,
            // Empty header value — Number("") would be 0, which would skip the
            // exponential backoff fallback. Fix forces fallback to default delay.
            headers: { "retry-after": "" },
          })
        }
        return jsonResponse({ ok: true })
      },
    }

    const start = Date.now()
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 50 }, // explicit fallback delay
    })

    await m.get("https://api.test/")
    const elapsed = Date.now() - start
    expect(attempt).toBe(2)
    // Backoff fallback (50ms) should run, not an instant 0ms retry.
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it("rejects malformed Retry-After tokens (e.g. '1.5e3', '0x10') and falls back", async () => {
    let attempt = 0
    const driver = {
      name: "track",
      request: async () => {
        attempt++
        if (attempt === 1) {
          return new Response(null, {
            status: 503,
            headers: { "retry-after": "0x10" }, // not a valid HTTP token
          })
        }
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({ driver, retry: { limit: 1, delay: () => 0 } })
    await m.get("https://api.test/")
    expect(attempt).toBe(2)
  })
})

describe("audit pass 1 — TimeoutError carries the configured timeout (Bug 18)", () => {
  it("error.timeout reflects the option, not 0", async () => {
    const driver = {
      name: "slow",
      request: (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(req.signal!.reason), { once: true })
        }),
    }

    const m = createMisina({ driver, retry: 0, timeout: 25 })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      if (isTimeoutError(err)) {
        expect(err.timeout).toBe(25)
        expect(err.message).toContain("25ms")
      } else {
        throw err
      }
    }
  }, 3000)
})

describe("audit pass 1 — HTTPError.data is parsed during retry (Bug 16)", () => {
  it("ctx.error.data is the parsed JSON body when shouldRetry inspects it", async () => {
    let seenData: unknown
    let attempt = 0
    const driver = {
      name: "track",
      request: async () => {
        attempt++
        if (attempt === 1) {
          return new Response(JSON.stringify({ code: "rate_limited" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        }
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: {
        limit: 1,
        delay: () => 0,
        shouldRetry: (ctx) => {
          if (isHTTPError(ctx.error)) seenData = ctx.error.data
          return true
        },
      },
    })

    await m.get("https://api.test/")
    expect(seenData).toEqual({ code: "rate_limited" })
  })
})

describe("audit pass 1 — DELETE may carry a body, GET/HEAD/OPTIONS may not (Bug 4)", () => {
  it("DELETE forwards a JSON body", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.request("https://api.test/", {
      method: "DELETE",
      body: { reason: "x" },
    })

    expect(getMockApi(driver)?.calls[0]?.body).toBe(JSON.stringify({ reason: "x" }))
  })

  it("OPTIONS body is dropped silently", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.request("https://api.test/", {
      method: "OPTIONS",
      body: { ignored: true },
    })

    expect(getMockApi(driver)?.calls[0]?.body).toBeUndefined()
  })
})

describe("audit pass 1 — array null elements dropped (Bug 1)", () => {
  it("query: { tags: [1, null, 2] } drops the null", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", {
      query: { tags: [1, null, 2] as unknown as number[] },
    })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.getAll("tags")).toEqual(["1", "2"])
  })

  it("query: { tags: [] } produces no key (Bug 2 — comma format)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, arrayFormat: "comma" })

    await m.get("https://api.test/", { query: { tags: [] } })
    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.has("tags")).toBe(false)
  })
})

describe("audit pass 1 — defer headers run smuggling guard (Bug 20)", () => {
  it("rejects CR/LF injected via defer", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      defer: () => ({ headers: { "x-evil": "value\r\nX-Smuggled: yes" } }),
    })

    await expect(m.get("https://api.test/")).rejects.toThrow(/control character/)
  })
})

describe("audit pass 1 — case-insensitive header merge in .extend() (Bug 28)", () => {
  it("does not duplicate Authorization vs authorization across parent/child", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const parent = createMisina({
      driver,
      retry: 0,
      headers: { Authorization: "Bearer parent" },
    })
    const child = parent.extend({ headers: { authorization: "Bearer child" } })

    await child.get("https://api.test/")
    const headers = getMockApi(driver)!.calls[0]!.headers

    expect(headers.authorization).toBe("Bearer child")
    expect(headers.Authorization).toBeUndefined()
  })

  it("replaceOption() still replaces wholesale", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const parent = createMisina({
      driver,
      retry: 0,
      headers: { Authorization: "Bearer parent", "x-keep": "yes" },
    })
    const child = parent.extend({
      headers: replaceOption({ "x-new": "only" }),
    })

    await child.get("https://api.test/")
    const headers = getMockApi(driver)!.calls[0]!.headers
    expect(headers["x-new"]).toBe("only")
    expect(headers.authorization).toBeUndefined()
    expect(headers["x-keep"]).toBeUndefined()
  })
})

describe("audit pass 1 — content-type stripped on POST→GET demote (Bug 14)", () => {
  it("303 redirect from POST drops content-type and content-length", async () => {
    const seen: { url: string; method: string; ct: string | null; cl: string | null }[] = []
    const driver = {
      name: "redirect",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          method: req.method,
          ct: req.headers.get("content-type"),
          cl: req.headers.get("content-length"),
        })
        if (req.url === "https://api.test/post") {
          return new Response(null, {
            status: 303,
            headers: { location: "https://api.test/result" },
          })
        }
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({ driver, retry: 0 })
    await m.post("https://api.test/post", { hello: "world" })

    expect(seen).toHaveLength(2)
    expect(seen[1]?.method).toBe("GET")
    expect(seen[1]?.ct).toBeNull()
    expect(seen[1]?.cl).toBeNull()
  })
})

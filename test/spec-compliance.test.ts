import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("RFC 9110 §15.4 — redirect method semantics", () => {
  it("307 preserves POST method and body", async () => {
    const seen: { url: string; method: string; body: string | undefined }[] = []
    const driver = {
      name: "redirect",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          method: req.method,
          body: req.body ? await req.clone().text() : undefined,
        })
        if (req.url === "https://api.test/start") {
          return new Response(null, {
            status: 307,
            headers: { location: "https://api.test/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({ driver, retry: 0 })
    await m.post("https://api.test/start", { hello: "world" })

    expect(seen[1]?.method).toBe("POST")
    expect(seen[1]?.body).toBe(JSON.stringify({ hello: "world" }))
  })

  it("308 preserves PUT method and body", async () => {
    const seen: { method: string; body: string | undefined }[] = []
    const driver = {
      name: "redirect",
      request: async (req: Request) => {
        seen.push({
          method: req.method,
          body: req.body ? await req.clone().text() : undefined,
        })
        if (req.url === "https://api.test/start") {
          return new Response(null, {
            status: 308,
            headers: { location: "https://api.test/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({ driver, retry: 0 })
    await m.put("https://api.test/start", { x: 1 })

    expect(seen[1]?.method).toBe("PUT")
    expect(seen[1]?.body).toBe(JSON.stringify({ x: 1 }))
  })

  it("303 forces method to GET regardless of original method", async () => {
    const seen: { method: string }[] = []
    const driver = {
      name: "redirect",
      request: async (req: Request) => {
        seen.push({ method: req.method })
        if (req.url === "https://api.test/start") {
          return new Response(null, {
            status: 303,
            headers: { location: "https://api.test/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({ driver, retry: 0 })
    await m.put("https://api.test/start", { x: 1 })

    expect(seen[1]?.method).toBe("GET")
  })

  it("malformed Location header throws a helpful error", async () => {
    const driver = {
      name: "broken",
      request: async () =>
        new Response(null, {
          status: 302,
          // unbalanced brackets are rejected by the WHATWG URL parser
          headers: { location: "http://[bad" },
        }),
    }

    const m = createMisina({ driver, retry: 0 })
    await expect(m.get("https://api.test/")).rejects.toThrow(/Location header/)
  })
})

describe("Web Fetch — body re-use after consumption", () => {
  it("non-stream body (string) is fine across retries", async () => {
    let attempts = 0
    const driver = {
      name: "flaky",
      request: async (req: Request) => {
        attempts++
        const body = req.body ? await req.clone().text() : ""
        if (attempts < 3) return new Response("nope", { status: 503 })
        return jsonResponse({ ok: true, body })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 3, methods: ["POST"], delay: () => 0 },
    })

    const res = await m.post<{ ok: boolean; body: string }>("https://api.test/", {
      hello: "world",
    })

    expect(attempts).toBe(3)
    expect(res.data.body).toBe(JSON.stringify({ hello: "world" }))
  })
})

describe("body serialization — class instance refusal", () => {
  it("throws TypeError on a non-plain class instance without toJSON()", async () => {
    class Custom {
      constructor(public x: number) {}
    }
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await expect(m.post("https://api.test/", new Custom(1))).rejects.toThrow(/non-plain object/)
  })

  it("accepts class instances that define toJSON()", async () => {
    class Money {
      constructor(
        public amount: number,
        public currency: string,
      ) {}
      toJSON(): { amount: number; currency: string } {
        return { amount: this.amount, currency: this.currency }
      }
    }

    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/", new Money(100, "USD"))

    expect(getMockApi(driver)?.calls[0]?.body).toBe(
      JSON.stringify({ amount: 100, currency: "USD" }),
    )
  })

  it("accepts plain objects normally", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/", { plain: true })
    expect(getMockApi(driver)?.calls[0]?.body).toBe(JSON.stringify({ plain: true }))
  })

  it("accepts arrays", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/", [1, 2, 3])
    expect(getMockApi(driver)?.calls[0]?.body).toBe(JSON.stringify([1, 2, 3]))
  })

  it("accepts Date via toJSON", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    const d = new Date("2026-01-01T00:00:00Z")
    await m.post("https://api.test/", d)

    expect(getMockApi(driver)?.calls[0]?.body).toBe(JSON.stringify(d))
  })
})

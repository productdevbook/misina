import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"
import { cookieJar, MemoryCookieJar } from "../src/cookie/index.ts"
import { basic, bearer } from "../src/auth/index.ts"
import { paginateAll } from "../src/paginate/index.ts"
import { cache, memoryStore } from "../src/cache/index.ts"
import { sseStream, ndjsonStream } from "../src/stream/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("query serialization (#11)", () => {
  it("serializes arrays in brackets format", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, arrayFormat: "brackets" })

    await m.get("https://api.test/", { query: { tags: ["a", "b"] } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.getAll("tags[]")).toEqual(["a", "b"])
  })

  it("uses paramsSerializer override", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      paramsSerializer: (params) => `custom=${Object.keys(params).join(",")}`,
    })

    await m.get("https://api.test/", { query: { a: 1, b: 2 } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("custom")).toBe("a,b")
  })

  it("accepts URLSearchParams as query", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { query: new URLSearchParams({ x: "y" }) })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("x")).toBe("y")
  })
})

describe("defer (#24)", () => {
  it("late-binds headers per request", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    let token = "first"

    const m = createMisina({
      driver,
      retry: 0,
      defer: () => ({ headers: { Authorization: `Bearer ${token}` } }),
    })

    await m.get("https://api.test/")
    token = "second"
    await m.get("https://api.test/")

    expect(getMockApi(driver)!.calls[0]!.headers.authorization).toBe("Bearer first")
    expect(getMockApi(driver)!.calls[1]!.headers.authorization).toBe("Bearer second")
  })
})

describe("cookie jar (#21)", () => {
  it("stores Set-Cookie and echoes Cookie on next request", async () => {
    let calls = 0
    const driver = mockDriverFactory({
      handler: async (req) => {
        calls++
        if (calls === 1) {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "session=abc; Path=/" },
          })
        }
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") }), {
          headers: { "content-type": "application/json" },
        })
      },
    })

    const jar = new MemoryCookieJar()
    const m = createMisina({ driver, retry: 0, use: [cookieJar(jar)] })

    await m.get("https://api.test/login")
    const res = await m.get<{ cookie: string }>("https://api.test/profile")

    expect(res.data.cookie).toBe("session=abc")
  })
})

describe("auth helpers (#15)", () => {
  it("bearer adds Authorization header", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, use: [bearer("abc123")] })

    await m.get("https://api.test/")
    expect(getMockApi(driver)!.calls[0]!.headers.authorization).toBe("Bearer abc123")
  })

  it("bearer accepts function source", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, use: [bearer(() => "dynamic")] })

    await m.get("https://api.test/")
    expect(getMockApi(driver)!.calls[0]!.headers.authorization).toBe("Bearer dynamic")
  })

  it("basic encodes credentials", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0, use: [basic("user", "pass")] })

    await m.get("https://api.test/")
    const auth = getMockApi(driver)!.calls[0]!.headers.authorization
    expect(auth).toMatch(/^Basic /)
    expect(atob(auth!.replace("Basic ", ""))).toBe("user:pass")
  })
})

describe("pagination (#20)", () => {
  it("follows Link rel=next header by default", async () => {
    let page = 0
    const driver = mockDriverFactory({
      handler: async (req) => {
        page++
        const url = new URL(req.url)
        const items = page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }]
        const link =
          page === 1
            ? `<${url.origin}/items?page=2>; rel="next", <${url.origin}/items?page=2>; rel="last"`
            : ""
        return new Response(JSON.stringify(items), {
          headers: {
            "content-type": "application/json",
            ...(link ? { link } : {}),
          },
        })
      },
    })

    const m = createMisina({ driver, retry: 0 })
    const all = await paginateAll<{ id: number }>(m, "https://api.test/items?page=1")

    expect(all.map((i) => i.id)).toEqual([1, 2, 3])
  })
})

describe("cache (#14)", () => {
  it("returns cached response within TTL", async () => {
    let calls = 0
    const driver = mockDriverFactory({
      handler: async () => {
        calls++
        return new Response(JSON.stringify({ count: calls }), {
          headers: { "content-type": "application/json" },
        })
      },
    })

    const store = memoryStore()
    const m = createMisina({ driver, retry: 0, use: [cache({ store, ttl: 5000 })] })

    const a = await m.get<{ count: number }>("https://api.test/")
    const b = await m.get<{ count: number }>("https://api.test/")

    expect(a.data.count).toBe(1)
    expect(b.data.count).toBe(1) // served from cache
    expect(calls).toBe(1)
  })
})

describe("streaming (#7)", () => {
  it("parses SSE events", async () => {
    const body = [
      "event: message",
      "data: hello",
      "",
      "event: bye",
      "data: world",
      "data: more",
      "",
    ].join("\n")

    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })

    const events = []
    for await (const event of sseStream(response)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ event: "message", data: "hello" })
    expect(events[1]).toMatchObject({ event: "bye", data: "world\nmore" })
  })

  it("parses NDJSON", async () => {
    const response = new Response('{"a":1}\n{"a":2}\n{"a":3}\n', {
      headers: { "content-type": "application/x-ndjson" },
    })

    const items: { a: number }[] = []
    for await (const item of ndjsonStream<{ a: number }>(response)) {
      items.push(item)
    }

    expect(items).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })
})

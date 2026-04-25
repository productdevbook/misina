import { describe, expect, it } from "vitest"
import { createTestMisina } from "../src/test/index.ts"

describe("createTestMisina — wildcard & dynamic responses", () => {
  it("trailing wildcard `*` matches anything", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /api/*": { status: 200, body: { ok: true } } },
    })

    await t.client.get("https://api.test/api/anything/here/at/all")
    await t.client.get("https://api.test/api/x")
    expect(t.calls).toHaveLength(2)
  })

  it("wildcard with `:param` before it", async () => {
    let captured: { id: string } | undefined
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /users/:id/*": ({ params }) => {
          captured = { id: params.id ?? "" }
          return { status: 200, body: {} }
        },
      },
    })

    await t.client.get("https://api.test/users/42/posts/comments")
    expect(captured?.id).toBe("42")
  })

  it("dynamic response based on request body", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "POST /echo": async ({ request }) => {
          const body = await request.json()
          return { status: 200, body }
        },
      },
    })

    const res = await t.client.post<{ msg: string }>("https://api.test/echo", { msg: "hi" })
    expect(res.data.msg).toBe("hi")
  })

  it("dynamic response based on query string", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /search": ({ url }) => {
          const q = url.searchParams.get("q")
          return { status: 200, body: { hits: q === "fish" ? 3 : 0 } }
        },
      },
    })

    const r1 = await t.client.get<{ hits: number }>("https://api.test/search", {
      query: { q: "fish" },
    })
    const r2 = await t.client.get<{ hits: number }>("https://api.test/search", {
      query: { q: "boat" },
    })
    expect(r1.data.hits).toBe(3)
    expect(r2.data.hits).toBe(0)
  })

  it("multiple routes — first match wins", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /users/me": { status: 200, body: { who: "me" } },
        "GET /users/:id": { status: 200, body: { who: "other" } },
      },
    })

    const me = await t.client.get<{ who: string }>("https://api.test/users/me")
    const other = await t.client.get<{ who: string }>("https://api.test/users/42")
    expect(me.data.who).toBe("me")
    expect(other.data.who).toBe("other")
  })

  it("encoded path params are decoded", async () => {
    let captured: string | undefined
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /search/:q": ({ params }) => {
          captured = params.q
          return { status: 200, body: {} }
        },
      },
    })

    await t.client.get("https://api.test/search/hello%20world")
    expect(captured).toBe("hello world")
  })

  it("path with regex meta-characters is escaped (not interpreted)", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /a.b.c/x": { status: 200, body: {} } },
      strict: true,
    })

    await t.client.get("https://api.test/a.b.c/x")
    // a.b.c matches literally — try aXbXc/x and verify it does NOT match.
    await expect(t.client.get("https://api.test/aXbXc/x")).rejects.toThrow(/no route matched/)
  })

  it("Promise-returning handler is awaited", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /slow": async () => {
          await new Promise((r) => setTimeout(r, 5))
          return { status: 200, body: { delayed: true } }
        },
      },
    })

    const res = await t.client.get<{ delayed: boolean }>("https://api.test/slow")
    expect(res.data.delayed).toBe(true)
  })

  it("returning a real Response object works", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /raw": () =>
          new Response(JSON.stringify({ raw: true }), {
            status: 200,
            headers: { "content-type": "application/json", "x-custom": "yes" },
          }),
      },
    })

    const res = await t.client.get<{ raw: boolean }>("https://api.test/raw")
    expect(res.data.raw).toBe(true)
    expect(res.headers["x-custom"]).toBe("yes")
  })

  it("recorder reset after each request makes lastCall semantic-only on most-recent", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /x": { status: 200, body: {} } },
    })

    await t.client.get("https://api.test/x", { headers: { "x-tag": "1" } })
    await t.client.get("https://api.test/x", { headers: { "x-tag": "2" } })
    expect(t.lastCall()?.headers["x-tag"]).toBe("2")
    expect(t.calls[0]?.headers["x-tag"]).toBe("1")
  })
})

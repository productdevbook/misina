import { describe, expect, it } from "vitest"
import { createTestMisina } from "../src/test/index.ts"

describe("createTestMisina — pattern matching", () => {
  it("`* /any` matches any method on /any", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "* /any": { status: 200, body: { ok: true } } },
    })

    await t.client.get("https://api.test/any")
    await t.client.post("https://api.test/any", { x: 1 })
    await t.client.delete("https://api.test/any")
    expect(t.calls).toHaveLength(3)
  })

  it("path with multiple :params binds each", async () => {
    let captured: Record<string, string> | undefined
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /a/:x/b/:y": ({ params }) => {
          captured = params
          return { status: 200, body: { ok: true } }
        },
      },
    })

    await t.client.get("https://api.test/a/foo/b/bar")
    expect(captured).toEqual({ x: "foo", y: "bar" })
  })

  it("static route definition can be a TestResponseInit object", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /static": { status: 201, body: { created: true } },
      },
    })

    const res = await t.client.get<{ created: boolean }>("https://api.test/static")
    expect(res.status).toBe(201)
    expect(res.data.created).toBe(true)
  })

  it("strict mode (default) throws on unmatched route", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /known": { status: 200, body: {} },
      },
    })

    await expect(t.client.get("https://api.test/unknown")).rejects.toThrow(/no route matched/)
  })

  it("strict: false returns 404 instead of throwing", async () => {
    const t = createTestMisina({
      retry: 0,
      strict: false,
      throwHttpErrors: false,
      routes: { "GET /known": { status: 200, body: {} } },
    })

    const res = await t.client.get("https://api.test/unknown")
    expect(res.status).toBe(404)
  })

  it("delay simulates latency", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /slow": { status: 200, body: {}, delay: 30 } },
    })

    const start = Date.now()
    await t.client.get("https://api.test/slow")
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(20)
  })

  it("throw: 'string' produces a NetworkError", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /flaky": { throw: "fetch failed" } },
    })

    await expect(t.client.get("https://api.test/flaky")).rejects.toMatchObject({
      name: "NetworkError",
    })
  })

  it("recorder captures method, url, headers, body", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "POST /x": { status: 200 } },
    })

    await t.client.post(
      "https://api.test/x",
      { hello: "world" },
      {
        headers: { "x-trace": "abc" },
      },
    )

    const call = t.lastCall()
    expect(call?.method).toBe("POST")
    expect(call?.url).toBe("https://api.test/x")
    expect(call?.headers["x-trace"]).toBe("abc")
    expect(call?.body).toBe(JSON.stringify({ hello: "world" }))
  })

  it("reset clears the call log", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "GET /x": { status: 200 } },
    })

    await t.client.get("https://api.test/x")
    expect(t.calls).toHaveLength(1)
    t.reset()
    expect(t.calls).toHaveLength(0)
  })
})

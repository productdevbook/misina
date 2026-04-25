import { describe, expect, it } from "vitest"
import { createTestMisina } from "../src/test/index.ts"

describe("createTestMisina", () => {
  it("matches GET /users/:id with params", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /users/:id": ({ params }) => ({ status: 200, body: { id: params.id } }),
      },
    })

    const res = await t.client.get<{ id: string }>("https://api.test/users/42")
    expect(res.data.id).toBe("42")
    expect(t.calls).toHaveLength(1)
  })

  it("strict mode throws on unmatched route", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /known": () => ({ status: 200 }),
      },
    })

    await expect(t.client.get("https://api.test/unknown")).rejects.toThrow(/no route matched/)
  })

  it("simulates network error via { throw }", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: {
        "GET /flaky": () => ({ throw: "fetch failed" }),
      },
    })

    await expect(t.client.get("https://api.test/flaky")).rejects.toMatchObject({
      name: "NetworkError",
    })
  })

  it("records calls and lastCall()", async () => {
    const t = createTestMisina({
      retry: 0,
      routes: { "* /*": () => ({ status: 200, body: {} }) },
    })

    await t.client.post("https://api.test/x", { a: 1 })

    expect(t.calls).toHaveLength(1)
    expect(t.lastCall()?.method).toBe("POST")
    expect(t.lastCall()?.body).toBe(JSON.stringify({ a: 1 }))

    t.reset()
    expect(t.calls).toHaveLength(0)
  })
})

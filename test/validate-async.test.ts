import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("validateResponse — async predicate", () => {
  it("awaits an async validateResponse before deciding", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ id: "X" }) })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: async ({ data }) => {
        await new Promise((r) => setTimeout(r, 5))
        // Reject if id starts with X
        if ((data as { id: string }).id.startsWith("X")) return false
        return true
      },
    })

    await expect(m.get("https://api.test/")).rejects.toMatchObject({
      name: "HTTPError",
    })
  })

  it("async validateResponse can return a custom Error", async () => {
    class BizError extends Error {
      override readonly name = "BizError"
    }
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return new BizError("nope")
      },
    })

    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(BizError)
  })

  it("validateResponse returning true short-circuits even on 4xx", async () => {
    const driver = mockDriverFactory({
      response: new Response("oops", { status: 418 }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: async () => true,
    })

    const res = await m.get("https://api.test/")
    expect(res.status).toBe(418)
  })
})

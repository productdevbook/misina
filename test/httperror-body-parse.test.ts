import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"

describe("HTTPError — body parse failure on error responses", () => {
  it("a 500 with broken JSON body still surfaces as HTTPError, not SyntaxError", async () => {
    const driver = {
      name: "broken",
      request: async () =>
        new Response("not-json-at-all{", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = await m.get("https://api.test/").catch((e) => e)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err.status).toBe(500)
    // The unparseable body should be available as raw text rather than throwing.
    // We accept either undefined or the raw string — what matters is no SyntaxError.
    expect(err.name).toBe("HTTPError")
  })

  it("a 400 with broken JSON body — HTTPError carries the original response", async () => {
    const driver = {
      name: "broken",
      request: async () =>
        new Response('{"truncated', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = await m.get("https://api.test/").catch((e) => e)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err.response).toBeInstanceOf(Response)
    expect(err.response.status).toBe(400)
  })

  it("a 200 with broken JSON body still throws (different contract — successful response)", async () => {
    // Successful response with malformed body is a real bug — surface it.
    const driver = {
      name: "broken",
      request: async () =>
        new Response('{"x":', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    await expect(m.get("https://api.test/")).rejects.toThrow()
  })
})

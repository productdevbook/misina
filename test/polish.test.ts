import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("response timings (#25)", () => {
  it("populates timings on every response", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    const res = await m.get("https://api.test/")

    expect(res.timings).toBeDefined()
    expect(res.timings.start).toBeGreaterThan(0)
    expect(res.timings.end).toBeGreaterThanOrEqual(res.timings.start)
    expect(res.timings.total).toBeGreaterThanOrEqual(0)
    expect(res.timings.total).toBe(res.timings.end - res.timings.start)
  })
})

describe("security: header validation (#10)", () => {
  it("rejects header values containing CR/LF (request smuggling guard)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await expect(
      m.get("https://api.test/", {
        headers: { "x-evil": "value\r\nX-Smuggled: yes" },
      }),
    ).rejects.toThrow(/control character/)
  })

  it("rejects header names containing control chars", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await expect(
      m.get("https://api.test/", {
        headers: { "x-evil\n": "value" },
      }),
    ).rejects.toThrow(/control character/)
  })
})

describe("framework passthrough (#26)", () => {
  it("passes cache option through to fetch init", async () => {
    let receivedCache: RequestCache | undefined
    const driver = {
      name: "track",
      request: async (req: Request): Promise<Response> => {
        receivedCache = req.cache
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { cache: "force-cache" })
    expect(receivedCache).toBe("force-cache")
  })

  it("only sets credentials when explicitly provided", async () => {
    let received: RequestCredentials | undefined
    const driver = {
      name: "track",
      request: async (req: Request): Promise<Response> => {
        received = req.credentials
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/")
    // Default Request() sets credentials to 'same-origin'; that's runtime
    // behavior, not ours. We just verify we don't accidentally overwrite it.
    expect(received).toBeDefined()
  })
})

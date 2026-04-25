import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

describe("parseJson context (ky #849)", () => {
  it("optional ctx receives request and response for routing decisions", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ raw: 1 }), {
        headers: { "content-type": "application/json", "x-route": "v2" },
      }),
    })

    let observedUrl: string | undefined
    let observedHeader: string | null | undefined

    const m = createMisina({
      driver,
      retry: 0,
      parseJson: (text, ctx) => {
        observedUrl = ctx?.request.url
        observedHeader = ctx?.response.headers.get("x-route")
        return JSON.parse(text)
      },
    })

    await m.get("https://api.test/items")

    expect(observedUrl).toBe("https://api.test/items")
    expect(observedHeader).toBe("v2")
  })

  it("works without context (backward-compatible)", async () => {
    const driver = mockDriverFactory({
      response: new Response('{"a":1}', {
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      parseJson: (text) => JSON.parse(text),
    })

    const res = await m.get<{ a: number }>("https://api.test/")
    expect(res.data).toEqual({ a: 1 })
  })
})

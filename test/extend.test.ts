import { describe, expect, it } from "vitest"
import { createMisina, replaceOption } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe(".extend()", () => {
  it("deep-merges headers (child wins, parent preserved)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const parent = createMisina({
      driver,
      headers: { "x-parent": "yes", authorization: "Bearer base" },
    })
    const child = parent.extend({ headers: { authorization: "Bearer child" } })

    await child.get("https://example.test/")

    const headers = getMockApi(driver)!.calls[0]!.headers
    expect(headers["x-parent"]).toBe("yes")
    expect(headers["authorization"]).toBe("Bearer child")
  })

  it("concatenates hooks across parent and child", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const parent = createMisina({
      driver,
      hooks: { beforeRequest: () => void order.push("parent") },
    })
    const child = parent.extend({
      hooks: { beforeRequest: () => void order.push("child") },
    })

    await child.get("https://example.test/")

    expect(order).toEqual(["parent", "child"])
  })

  it("replaceOption() forces replace over merge", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const parent = createMisina({
      driver,
      hooks: { beforeRequest: () => void order.push("parent") },
    })
    const child = parent.extend({
      hooks: replaceOption({ beforeRequest: () => void order.push("child") }),
    })

    await child.get("https://example.test/")

    expect(order).toEqual(["child"])
  })

  it("function form receives parent defaults", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const parent = createMisina({ driver, baseURL: "https://api.example.com/v1" })

    const child = parent.extend((p) => ({
      baseURL: p.baseURL?.replace("/v1", "/v2"),
    }))

    await child.get("hello")
    expect(getMockApi(driver)!.calls[0]!.url).toBe("https://api.example.com/v2/hello")
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("headers — content-type with charset is preserved", () => {
  it("user-set content-type with charset isn't replaced by JSON default", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.post(
      "https://api.test/",
      { hello: "world" },
      {
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    )

    const ct = getMockApi(driver)?.calls[0]?.headers["content-type"]
    expect(ct).toBe("application/json; charset=utf-8")
  })

  it("text body with custom content-type is preserved verbatim", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/", "<xml/>", {
      headers: { "content-type": "application/xml" },
    })

    const ct = getMockApi(driver)?.calls[0]?.headers["content-type"]
    expect(ct).toBe("application/xml")
    expect(getMockApi(driver)?.calls[0]?.body).toBe("<xml/>")
  })
})

describe("headers — defaults vs per-request override", () => {
  it("per-request header overrides default with the same name (case-insensitive)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      headers: { "X-API-Version": "1" },
    })

    await m.get("https://api.test/", { headers: { "x-api-version": "2" } })

    const headers = getMockApi(driver)?.calls[0]?.headers
    expect(headers?.["x-api-version"]).toBe("2")
    // Should not have the original case-variant lingering
    expect(
      Object.keys(headers ?? {}).filter((k) => k.toLowerCase() === "x-api-version"),
    ).toHaveLength(1)
  })

  it("default headers passed through when per-request doesn't set them", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      headers: { Authorization: "Bearer secret" },
    })

    await m.get("https://api.test/")

    expect(getMockApi(driver)?.calls[0]?.headers["authorization"]).toBe("Bearer secret")
  })
})

describe("headers — beforeRequest mutation visibility", () => {
  it("beforeRequest can add a header by returning a new Request", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          const headers = new Headers(ctx.request.headers)
          headers.set("x-trace", "abc")
          return new Request(ctx.request, { headers })
        },
      },
    })

    await m.get("https://api.test/")
    expect(getMockApi(driver)?.calls[0]?.headers["x-trace"]).toBe("abc")
  })
})

describe("headers — empty values and edge cases", () => {
  it("empty string header is sent (don't auto-strip)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { headers: { "x-empty": "" } })
    expect(getMockApi(driver)?.calls[0]?.headers["x-empty"]).toBe("")
  })
})

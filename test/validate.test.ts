import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

describe("validateResponse", () => {
  it("treats 200 with { ok: false } as failure when validateResponse rejects", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ ok: false, error: "soft" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: ({ data }) => (data as { ok: boolean }).ok === true,
    })

    await expect(m.get("https://example.test/")).rejects.toBeInstanceOf(HTTPError)
  })

  it("returns custom Error when validateResponse returns one", async () => {
    class BizError extends Error {
      override readonly name = "BizError"
    }
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      validateResponse: () => new BizError("nope"),
    })

    await expect(m.get("https://example.test/")).rejects.toBeInstanceOf(BizError)
  })

  it("passes through when validateResponse returns true even for 4xx", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 404 }),
    })

    const m = createMisina({ driver, retry: 0, validateResponse: () => true })
    const res = await m.get("https://example.test/")

    expect(res.status).toBe(404)
  })
})

describe("parseJson / stringifyJson", () => {
  it("uses custom parseJson for response body", async () => {
    const driver = mockDriverFactory({
      response: new Response('{"a":1}', {
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      parseJson: () => ({ replaced: true }),
    })

    const res = await m.get<{ replaced: boolean }>("https://example.test/")
    expect(res.data.replaced).toBe(true)
  })

  it("uses custom stringifyJson for request body", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { headers: { "content-type": "application/json" } }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      stringifyJson: () => '{"replaced":true}',
    })

    await m.post("https://example.test/", { original: true })
  })
})

describe("status-based catchers", () => {
  it("recovers from 404 via .onError(404, fn)", async () => {
    const driver = mockDriverFactory({
      response: new Response("not found", { status: 404 }),
    })

    const m = createMisina({ driver, retry: 0 })

    const result = await m
      .get<unknown>("https://example.test/missing")
      .onError(404, () => "fallback")

    expect(result).toBe("fallback")
  })

  it("recovers from array of statuses", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 401 }),
    })

    const m = createMisina({ driver, retry: 0 })

    const result = await m.get<unknown>("https://example.test/").onError([401, 403], () => "auth")

    expect(result).toBe("auth")
  })

  it("matches by error class name", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 500 }),
    })

    const m = createMisina({ driver, retry: 0 })

    const result = await m
      .get<unknown>("https://example.test/")
      .onError("HTTPError", () => "handled")

    expect(result).toBe("handled")
  })

  it("re-throws when matcher does not match", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 500 }),
    })

    const m = createMisina({ driver, retry: 0 })

    await expect(
      m.get("https://example.test/").onError(404, () => "ignored"),
    ).rejects.toBeInstanceOf(HTTPError)
  })
})

describe("response.type passthrough (#33)", () => {
  it("exposes response.type on success path", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { headers: { "content-type": "application/json" } }),
    })

    const m = createMisina({ driver, retry: 0 })
    const res = await m.get("https://example.test/")
    // mock driver creates a "default" response from `new Response()`
    expect(typeof res.type).toBe("string")
  })
})

describe("URL composition (#29)", () => {
  it("rejects absolute URL when allowAbsoluteUrls is false", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { headers: { "content-type": "application/json" } }),
    })

    const m = createMisina({
      driver,
      retry: 0,
      baseURL: "https://api.example.com",
      allowAbsoluteUrls: false,
    })

    await expect(m.get("https://attacker.example/")).rejects.toThrow(/allowAbsoluteUrls/)
  })

  it("allows absolute URL by default", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { headers: { "content-type": "application/json" } }),
    })

    const m = createMisina({ driver, retry: 0, baseURL: "https://api.example.com" })
    const res = await m.get("https://other.example/")

    expect(res.status).toBe(200)
  })
})

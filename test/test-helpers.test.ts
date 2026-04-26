import { describe, expect, it } from "vitest"
import { HTTPError } from "../src/index.ts"
import {
  createTestMisina,
  DEFAULT_VOLATILE_HEADERS,
  harToCassette,
  misinaCallSerializer,
  randomNetworkError,
  randomStatus,
  replayFromJSON,
} from "../src/test/index.ts"

describe("coverage()", () => {
  it("reports matched + unused routes", async () => {
    const t = createTestMisina({
      routes: {
        "GET /a": { status: 200 },
        "GET /b": { status: 200 },
        "POST /c": { status: 201 },
      },
    })
    await t.client.get("https://x.test/a")
    const cov = t.coverage()
    expect(cov.matched).toEqual(["GET /a"])
    expect(cov.unused).toEqual(["GET /b", "POST /c"])
    expect(cov.unmatched).toEqual([])
  })

  it("collects unmatched calls when strict: false", async () => {
    const t = createTestMisina({
      strict: false,
      routes: { "GET /known": { status: 200 } },
    })
    await t.client.get("https://x.test/unknown").catch(() => undefined)
    const cov = t.coverage()
    expect(cov.unused).toEqual(["GET /known"])
    expect(cov.unmatched).toHaveLength(1)
    expect(cov.unmatched[0]?.url).toContain("/unknown")
  })

  it("reset() clears coverage state", async () => {
    const t = createTestMisina({
      routes: { "GET /a": { status: 200 } },
    })
    await t.client.get("https://x.test/a")
    expect(t.coverage().matched).toEqual(["GET /a"])
    t.reset()
    expect(t.coverage().matched).toEqual([])
    expect(t.coverage().unused).toEqual(["GET /a"])
  })
})

describe("randomStatus / randomNetworkError", () => {
  it("randomStatus picks from the configured pool", async () => {
    const t = createTestMisina({
      routes: {
        "GET /chaos": randomStatus([503, 503, 503], { msg: "down" }),
      },
    })
    await expect(t.client.get("https://x.test/chaos")).rejects.toBeInstanceOf(HTTPError)
  })

  it("randomNetworkError throws a TypeError each time", async () => {
    const t = createTestMisina({
      routes: { "GET /down": randomNetworkError("net fail") },
    })
    await expect(t.client.get("https://x.test/down", { retry: 0 })).rejects.toThrow()
  })

  it("randomStatus rejects an empty pool", () => {
    expect(() => randomStatus([])).toThrow()
  })
})

describe("harToCassette", () => {
  it("converts a minimal HAR file to a misina cassette", async () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              method: "GET",
              url: "https://api.test/users/1",
              headers: [{ name: "Accept", value: "application/json" }],
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: [{ name: "Content-Type", value: "application/json" }],
              content: { text: '{"id":1}' },
            },
          },
        ],
      },
    }
    const cassette = harToCassette(har)
    expect(cassette).toHaveLength(1)
    expect(cassette[0]?.request.method).toBe("GET")
    expect(cassette[0]?.request.headers.accept).toBe("application/json")
    expect(cassette[0]?.response.body).toBe('{"id":1}')

    // Drop straight into replay.
    const handler = replayFromJSON(cassette)
    const t = createTestMisina({ routes: { "GET /users/:id": handler } })
    const res = await t.client.get<{ id: number }>("https://api.test/users/1")
    expect(res.data).toEqual({ id: 1 })
  })

  it("decodes base64 response bodies", () => {
    const har = {
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://x.test/", headers: [] },
            response: {
              status: 200,
              headers: [],
              content: {
                text: btoa("hello"),
                encoding: "base64",
              },
            },
          },
        ],
      },
    }
    const cassette = harToCassette(har)
    expect(cassette[0]?.response.body).toBe("hello")
  })
})

describe("misinaCallSerializer", () => {
  it("redacts default volatile headers", () => {
    const ser = misinaCallSerializer()
    const call = {
      url: "https://api.test/x",
      method: "GET",
      headers: {
        authorization: "Bearer secret",
        "x-request-id": "req_42",
        "content-type": "application/json",
      },
    }
    expect(ser.test(call)).toBe(true)
    const out = JSON.parse(ser.serialize(call))
    expect(out.headers.authorization).toBe("[redacted]")
    expect(out.headers["x-request-id"]).toBe("[redacted]")
    expect(out.headers["content-type"]).toBe("application/json")
    expect(out.__misina_call).toBe(true)
  })

  it("accepts a custom redact list", () => {
    const ser = misinaCallSerializer({ redactHeaders: ["x-tenant-id"] })
    const call = {
      url: "https://api.test/x",
      method: "GET",
      headers: {
        authorization: "Bearer secret",
        "x-tenant-id": "abc",
      },
    }
    const out = JSON.parse(ser.serialize(call))
    expect(out.headers.authorization).toBe("Bearer secret")
    expect(out.headers["x-tenant-id"]).toBe("[redacted]")
  })

  it("DEFAULT_VOLATILE_HEADERS is exported and contains common volatiles", () => {
    expect(DEFAULT_VOLATILE_HEADERS).toContain("authorization")
    expect(DEFAULT_VOLATILE_HEADERS).toContain("traceparent")
    expect(DEFAULT_VOLATILE_HEADERS).toContain("idempotency-key")
  })

  it("test() rejects non-MockCall values", () => {
    const ser = misinaCallSerializer()
    expect(ser.test(null)).toBe(false)
    expect(ser.test({})).toBe(false)
    expect(ser.test({ url: "x" })).toBe(false)
  })
})

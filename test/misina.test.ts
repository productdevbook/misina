import { describe, expect, it } from "vitest"
import {
  createMisina,
  defineDriver,
  HTTPError,
  isHTTPError,
  isNetworkError,
  NetworkError,
} from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("createMisina — basic flow", () => {
  it("dispatches a GET and parses JSON", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ ok: true }) })
    const m = createMisina({ driver })

    const res = await m.get<{ ok: boolean }>("https://example.test/x")

    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
    expect(getMockApi(driver)?.calls[0]?.method).toBe("GET")
  })

  it("serializes JSON bodies on POST", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver })

    await m.post("https://example.test/x", { a: 1 })

    const call = getMockApi(driver)?.calls[0]
    expect(call?.body).toBe(JSON.stringify({ a: 1 }))
    expect(call?.headers["content-type"]).toBe("application/json")
  })

  it("resolves baseURL with WHATWG URL", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, baseURL: "https://api.example.com/v1" })

    await m.get("users/42")

    expect(getMockApi(driver)?.calls[0]?.url).toBe("https://api.example.com/v1/users/42")
  })

  it("appends query parameters and skips undefined", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver })

    await m.get("https://example.test/", { query: { a: 1, b: undefined, c: [1, 2] } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.getAll("a")).toEqual(["1"])
    expect(url.searchParams.has("b")).toBe(false)
    expect(url.searchParams.getAll("c")).toEqual(["1", "2"])
  })

  it("merges default headers with per-request headers (last wins, lowercased)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      headers: { "X-Default": "yes", Authorization: "Bearer base" },
    })

    await m.get("https://example.test/", { headers: { Authorization: "Bearer override" } })

    const headers = getMockApi(driver)!.calls[0]!.headers
    expect(headers["x-default"]).toBe("yes")
    expect(headers["authorization"]).toBe("Bearer override")
  })
})

describe("createMisina — driver pattern", () => {
  it("accepts a custom driver via defineDriver", async () => {
    let received: Request | undefined
    const driver = defineDriver(() => ({
      name: "custom",
      request: async (req) => {
        received = req
        return jsonResponse({ from: "custom" })
      },
    }))()

    const m = createMisina({ driver })
    const res = await m.get<{ from: string }>("https://example.test/")

    expect(received?.url).toBe("https://example.test/")
    expect(res.data.from).toBe("custom")
  })

  it("returns body-less response for HEAD", async () => {
    const driver = mockDriverFactory({
      response: new Response(null, { status: 200 }),
    })
    const m = createMisina({ driver })

    const res = await m.head("https://example.test/")

    expect(res.data).toBeUndefined()
  })

  it("treats 204 No Content as bodyless without throwing", async () => {
    const driver = mockDriverFactory({ response: new Response(null, { status: 204 }) })
    const m = createMisina({ driver })

    const res = await m.get("https://example.test/")

    expect(res.status).toBe(204)
    expect(res.data).toBeUndefined()
  })
})

describe("createMisina — hooks lifecycle", () => {
  it("runs init hook synchronously before Request construction", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const m = createMisina({
      driver,
      hooks: {
        init: (opts) => {
          order.push("init")
          opts.headers["x-init"] = "1"
        },
        beforeRequest: (ctx) => {
          order.push("beforeRequest")
          expect(ctx.request.headers.get("x-init")).toBe("1")
        },
      },
    })

    await m.get("https://example.test/")

    expect(order).toEqual(["init", "beforeRequest"])
    expect(getMockApi(driver)!.calls[0]!.headers["x-init"]).toBe("1")
  })

  it("merges default and per-request hooks (defaults run first)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const m = createMisina({
      driver,
      hooks: { beforeRequest: () => void order.push("default") },
    })

    await m.get("https://example.test/", {
      hooks: { beforeRequest: () => void order.push("per-req") },
    })

    expect(order).toEqual(["default", "per-req"])
  })

  it("beforeRequest can return a Response and skip the driver entirely", async () => {
    let driverCalled = false
    const driver = defineDriver(() => ({
      name: "track",
      request: async () => {
        driverCalled = true
        return jsonResponse({ shouldNotSee: true })
      },
    }))()

    const m = createMisina({
      driver,
      hooks: {
        beforeRequest: () => jsonResponse({ stub: true }),
      },
    })

    const res = await m.get<{ stub: boolean }>("https://example.test/")

    expect(driverCalled).toBe(false)
    expect(res.data.stub).toBe(true)
  })

  it("afterResponse can replace the response", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ original: true }) })
    const m = createMisina({
      driver,
      hooks: {
        afterResponse: () => jsonResponse({ replaced: true }),
      },
    })

    const res = await m.get<{ replaced: boolean }>("https://example.test/")

    expect(res.data.replaced).toBe(true)
  })

  it("init hook errors are fatal — beforeRequest never runs", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    let beforeRequestRan = false

    const m = createMisina({
      driver,
      hooks: {
        init: () => {
          throw new Error("init blew up")
        },
        beforeRequest: () => {
          beforeRequestRan = true
        },
      },
    })

    await expect(m.get("https://example.test/")).rejects.toThrow("init blew up")
    expect(beforeRequestRan).toBe(false)
  })

  it("beforeError can transform the thrown error", async () => {
    const driver = mockDriverFactory({
      response: new Response("nope", { status: 500 }),
    })

    class WrappedError extends Error {
      override readonly name = "WrappedError"
    }

    const m = createMisina({
      driver,
      hooks: {
        beforeError: (err) => new WrappedError(`wrapped: ${err.message}`),
      },
    })

    await expect(m.get("https://example.test/")).rejects.toBeInstanceOf(WrappedError)
  })
})

describe("createMisina — errors", () => {
  it("throws HTTPError with parsed data on 4xx by default", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({ driver })

    await expect(m.get("https://example.test/missing")).rejects.toMatchObject({
      name: "HTTPError",
      status: 404,
      data: { error: "not found" },
    })

    try {
      await m.get("https://example.test/missing")
    } catch (err) {
      expect(isHTTPError(err)).toBe(true)
      expect((err as HTTPError).response.status).toBe(404)
    }
  })

  it("does not throw when throwHttpErrors is false", async () => {
    const driver = mockDriverFactory({
      response: new Response(JSON.stringify({}), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    })

    const m = createMisina({ driver, throwHttpErrors: false })
    const res = await m.get("https://example.test/")

    expect(res.status).toBe(500)
  })

  it("wraps fetch transport errors as NetworkError", async () => {
    const driver = defineDriver(() => ({
      name: "broken",
      request: async () => {
        throw new TypeError("fetch failed")
      },
    }))()

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://example.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(isNetworkError(err)).toBe(true)
      expect(err).toBeInstanceOf(NetworkError)
      expect((err as NetworkError).cause).toBeInstanceOf(TypeError)
    }
  })

  it("preserves user errors that aren't network errors", async () => {
    class CustomError extends Error {
      override readonly name = "CustomError"
    }
    const driver = defineDriver(() => ({
      name: "broken",
      request: async () => {
        throw new CustomError("custom")
      },
    }))()

    const m = createMisina({ driver })

    await expect(m.get("https://example.test/")).rejects.toBeInstanceOf(CustomError)
  })
})

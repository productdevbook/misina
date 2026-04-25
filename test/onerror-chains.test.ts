import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

describe("onError — predicate matcher", () => {
  it("function matcher receives the error and returns boolean", async () => {
    const driver = mockDriverFactory({
      response: new Response('{"reason":"rate limited"}', {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    })
    const m = createMisina({ driver, retry: 0 })

    const result = await m.get<unknown>("https://api.test/").onError(
      (e) => e instanceof HTTPError && e.status >= 400 && e.status < 500,
      () => "client-error",
    )

    expect(result).toBe("client-error")
  })

  it("predicate that doesn't match propagates the error", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 500 }),
    })
    const m = createMisina({ driver, retry: 0 })

    await expect(
      m.get("https://api.test/").onError(
        (e) => e instanceof HTTPError && e.status === 401,
        () => "auth",
      ),
    ).rejects.toBeInstanceOf(HTTPError)
  })
})

describe("onError — chaining", () => {
  it("multiple onError chained: first match wins, rest are bypassed", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 404 }),
    })
    const m = createMisina({ driver, retry: 0 })

    const result = await m
      .get<unknown>("https://api.test/")
      .onError(401, () => "auth")
      .onError(404, () => "not-found")
      .onError(500, () => "server")

    expect(result).toBe("not-found")
  })

  it("first matcher misses, second matcher catches", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 500 }),
    })
    const m = createMisina({ driver, retry: 0 })

    const result = await m
      .get<unknown>("https://api.test/")
      .onError(404, () => "404-only")
      .onError(500, () => "500-handler")

    expect(result).toBe("500-handler")
  })

  it("none match: error still propagates after the chain", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 500 }),
    })
    const m = createMisina({ driver, retry: 0 })

    await expect(
      m
        .get("https://api.test/")
        .onError(404, () => "x")
        .onError(401, () => "y"),
    ).rejects.toBeInstanceOf(HTTPError)
  })
})

describe("onError — handler throws", () => {
  it("throwing inside handler propagates the new error", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 500 }),
    })
    const m = createMisina({ driver, retry: 0 })

    class WrappedError extends Error {
      override readonly name = "WrappedError"
    }

    await expect(
      m.get("https://api.test/").onError(500, (e) => {
        throw new WrappedError(`wrapped: ${e.message}`)
      }),
    ).rejects.toBeInstanceOf(WrappedError)
  })

  it("async handler is awaited", async () => {
    const driver = mockDriverFactory({
      response: new Response("{}", { status: 503 }),
    })
    const m = createMisina({ driver, retry: 0 })

    const result = await m.get<unknown>("https://api.test/").onError(503, async () => {
      await new Promise((r) => setTimeout(r, 5))
      return "delayed-fallback"
    })

    expect(result).toBe("delayed-fallback")
  })
})

describe("onError — TypeError/network errors", () => {
  it("matches by error name 'NetworkError'", async () => {
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m
      .get<unknown>("https://api.test/")
      .onError("NetworkError", () => "offline")

    expect(result).toBe("offline")
  })

  it("matches via predicate via the underlying cause", async () => {
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.get<unknown>("https://api.test/").onError(
      (e) => {
        // Misina maps raw network errors to NetworkError; the original TypeError
        // is reachable on `error.cause`.
        if (!(e instanceof Error)) return false
        const cause = (e as { cause?: unknown }).cause
        return cause instanceof Error && cause.message.includes("fetch failed")
      },
      () => "network-down",
    )

    expect(result).toBe("network-down")
  })
})

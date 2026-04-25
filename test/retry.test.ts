import { describe, expect, it } from "vitest"
import { createMisina, defineDriver } from "../src/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("retry — defaults", () => {
  it("retries up to limit on 503, then succeeds", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "flaky",
      request: async () => {
        calls++
        if (calls <= 2) return new Response("nope", { status: 503 })
        return jsonResponse({ ok: true })
      },
    }))()

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 0 },
    })

    const res = await m.get<{ ok: boolean }>("https://example.test/")

    expect(calls).toBe(3)
    expect(res.data.ok).toBe(true)
  })

  it("does not retry POST by default", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "flaky",
      request: async () => {
        calls++
        return new Response("nope", { status: 503 })
      },
    }))()

    const m = createMisina({ driver, retry: { limit: 3, delay: () => 0 } })

    await expect(m.post("https://example.test/", { a: 1 })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it("respects shouldRetry override", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "flaky",
      request: async () => {
        calls++
        return new Response("nope", { status: 500 })
      },
    }))()

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 0, shouldRetry: () => false },
    })

    await expect(m.get("https://example.test/")).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it("retries network errors when method is allowed", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "flaky",
      request: async () => {
        calls++
        if (calls < 2) throw new TypeError("fetch failed")
        return jsonResponse({ ok: true })
      },
    }))()

    const m = createMisina({ driver, retry: { limit: 2, delay: () => 0 } })
    const res = await m.get<{ ok: boolean }>("https://example.test/")

    expect(calls).toBe(2)
    expect(res.data.ok).toBe(true)
  })
})

describe("retry — Retry-After", () => {
  it("honors Retry-After header in seconds", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "ratelimited",
      request: async () => {
        calls++
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0.05" }, // 50 ms
          })
        }
        return jsonResponse({ ok: true })
      },
    }))()

    const m = createMisina({ driver, retry: { limit: 1 } })

    const start = Date.now()
    const res = await m.get<{ ok: boolean }>("https://example.test/")
    const elapsed = Date.now() - start

    expect(calls).toBe(2)
    expect(res.data.ok).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(40)
  })

  it("caps Retry-After at maxRetryAfter", async () => {
    let calls = 0
    const driver = defineDriver(() => ({
      name: "ratelimited",
      request: async () => {
        calls++
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "9999" },
          })
        }
        return jsonResponse({ ok: true })
      },
    }))()

    const m = createMisina({
      driver,
      retry: { limit: 1, maxRetryAfter: 50 },
    })

    const start = Date.now()
    await m.get("https://example.test/")
    const elapsed = Date.now() - start

    expect(calls).toBe(2)
    expect(elapsed).toBeLessThan(500) // not 9999s
  })
})

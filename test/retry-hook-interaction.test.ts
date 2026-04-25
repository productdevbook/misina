import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("retry × hook interaction", () => {
  it("beforeRetry throwing aborts the retry chain (fatal hook error)", async () => {
    let attempts = 0
    const driver = {
      name: "f",
      request: async () => {
        attempts++
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }

    class HookAbort extends Error {
      override readonly name = "HookAbort"
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        beforeRetry: () => {
          throw new HookAbort("nope")
        },
      },
    })

    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(HookAbort)
    // Only the initial attempt — beforeRetry blew up before attempt #2.
    expect(attempts).toBe(1)
  })

  it("beforeRetry can return a fresh Request that overrides URL/headers", async () => {
    let attempts = 0
    const seen: { url: string; xRetry: string | null }[] = []
    const driver = {
      name: "f",
      request: async (req: Request) => {
        attempts++
        seen.push({ url: req.url, xRetry: req.headers.get("x-retry") })
        if (attempts === 1) {
          return jsonResponse(null, { status: 503 })
        }
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 2, delay: () => 1 },
      hooks: {
        beforeRetry: (ctx) => {
          const headers = new Headers(ctx.request.headers)
          headers.set("x-retry", String(ctx.attempt))
          return new Request("https://api.test/retry-target", { ...ctx.request, headers })
        },
      },
    })

    const res = await m.get<{ ok: boolean }>("https://api.test/initial")
    expect(res.data.ok).toBe(true)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ url: "https://api.test/initial", xRetry: null })
    expect(seen[1]).toEqual({ url: "https://api.test/retry-target", xRetry: "1" })
  })

  it("shouldRetry returning false stops retries", async () => {
    let attempts = 0
    const driver = {
      name: "f",
      request: async () => {
        attempts++
        return jsonResponse({}, { status: 500 })
      },
    }

    const m = createMisina({
      driver,
      throwHttpErrors: false,
      retry: {
        limit: 5,
        delay: () => 1,
        shouldRetry: ({ attempt }) => attempt < 1,
      },
    })

    const res = await m.get("https://api.test/")
    expect(res.status).toBe(500)
    // attempt=0 (initial) + attempt=1 (one retry) = 2 attempts.
    expect(attempts).toBe(2)
  })

  it("beforeRequest fires only on the first attempt, not on retries", async () => {
    let beforeRequestCalls = 0
    let attempts = 0
    const driver = {
      name: "f",
      request: async () => {
        attempts++
        if (attempts < 3) return jsonResponse({}, { status: 503 })
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        beforeRequest: () => {
          beforeRequestCalls++
        },
      },
    })

    await m.get("https://api.test/")
    expect(attempts).toBe(3)
    expect(beforeRequestCalls).toBe(1)
  })

  it("afterResponse fires for each attempt (including retried ones)", async () => {
    let attempts = 0
    let afterCalls = 0
    const driver = {
      name: "f",
      request: async () => {
        attempts++
        if (attempts < 3) return jsonResponse({}, { status: 503 })
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        afterResponse: () => {
          afterCalls++
        },
      },
    })

    await m.get("https://api.test/")
    expect(afterCalls).toBe(attempts)
  })

  it("retryOnTimeout: false skips retry on TimeoutError", async () => {
    let attempts = 0
    const driver = {
      name: "f",
      request: async (req: Request) => {
        attempts++
        return new Promise<Response>((_resolve, reject) => {
          if (req.signal.aborted) {
            reject(req.signal.reason)
            return
          }
          req.signal.addEventListener("abort", () => reject(req.signal.reason))
        })
      },
    }

    const m = createMisina({
      driver,
      timeout: 30,
      retry: { limit: 5, delay: () => 1, retryOnTimeout: false },
    })

    await expect(m.get("https://api.test/")).rejects.toMatchObject({ name: "TimeoutError" })
    expect(attempts).toBe(1)
  })

  it("ctx.attempt increases monotonically across retries", async () => {
    const seen: number[] = []
    let attempts = 0
    const driver = {
      name: "f",
      request: async () => {
        attempts++
        if (attempts < 3) return jsonResponse({}, { status: 503 })
        return jsonResponse({ ok: true })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
      hooks: {
        beforeRetry: (ctx) => {
          seen.push(ctx.attempt)
        },
      },
    })

    await m.get("https://api.test/")
    // beforeRetry fires for attempt=1 (between 0 and 1) and attempt=2.
    expect(seen).toEqual([1, 2])
  })
})

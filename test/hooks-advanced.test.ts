import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("beforeError chain — hooks pass the transformed error", () => {
  it("each hook sees the previous hook's return value", async () => {
    class FirstError extends Error {
      override readonly name = "FirstError"
    }
    class SecondError extends Error {
      override readonly name = "SecondError"
      constructor(public original: Error) {
        super("wrapped: " + original.message)
      }
    }

    const driver = mockDriverFactory({ response: new Response(null, { status: 500 }) })

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeError: [() => new FirstError("first"), (e) => new SecondError(e)],
      },
    })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(SecondError)
      expect((err as SecondError).original).toBeInstanceOf(FirstError)
      expect((err as SecondError).message).toBe("wrapped: first")
    }
  })
})

describe("beforeRetry — sees ctx.error from the previous attempt", () => {
  it("ctx.error is the parsed HTTPError, ctx.attempt increments", async () => {
    let attempts = 0
    const driver = {
      name: "flaky",
      request: async () => {
        attempts++
        if (attempts < 3) {
          return new Response(JSON.stringify({ retry: attempts }), {
            status: 503,
            headers: { "content-type": "application/json" },
          })
        }
        return jsonResponse({ ok: true })
      },
    }

    const seenAttempts: number[] = []
    const seenErrorData: unknown[] = []

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 0 },
      hooks: {
        beforeRetry: (ctx) => {
          seenAttempts.push(ctx.attempt)
          if (ctx.error && typeof ctx.error === "object" && "data" in ctx.error) {
            seenErrorData.push((ctx.error as { data: unknown }).data)
          }
        },
      },
    })

    await m.get("https://api.test/")

    expect(seenAttempts).toEqual([1, 2])
    expect(seenErrorData).toEqual([{ retry: 1 }, { retry: 2 }])
  })
})

describe("afterResponse — replacing the response with a new one", () => {
  it("returned Response replaces ctx.response and feeds finalizeResponse", async () => {
    const driver = mockDriverFactory({ response: new Response(null, { status: 500 }) })

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        afterResponse: () =>
          new Response(JSON.stringify({ rewritten: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    })

    const res = await m.get<{ rewritten: boolean }>("https://api.test/")
    expect(res.status).toBe(200)
    expect(res.data.rewritten).toBe(true)
  })

  it("multiple afterResponse hooks see each other's replacements", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ stage: 0 }) })

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        afterResponse: [
          () => jsonResponse({ stage: 1 }),
          (ctx) => {
            // Should see stage:1 in ctx.response
            const text = ctx.response?.headers.get("content-type") ?? ""
            return jsonResponse({ stage: 2, fromCt: text })
          },
        ],
      },
    })

    const res = await m.get<{ stage: number; fromCt: string }>("https://api.test/")
    expect(res.data.stage).toBe(2)
    expect(res.data.fromCt).toContain("application/json")
  })
})

describe("init hook — async-safe per-request even with shared closure", () => {
  it("interleaved requests don't see each other's transient state", async () => {
    const driver = {
      name: "slow",
      request: async (req: Request) => {
        // Delay just long enough that two concurrent calls overlap.
        await new Promise((r) => setTimeout(r, 5))
        return new Response(JSON.stringify({ x: req.headers.get("x-call") }), {
          headers: { "content-type": "application/json" },
        })
      },
    }

    let counter = 0
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        init: (options) => {
          counter++
          options.headers["x-call"] = `c${counter}`
        },
      },
    })

    const [a, b] = await Promise.all([
      m.get<{ x: string }>("https://api.test/a"),
      m.get<{ x: string }>("https://api.test/b"),
    ])

    // Each request received its own x-call header without cross-contamination.
    expect(new Set([a.data.x, b.data.x])).toEqual(new Set(["c1", "c2"]))
  })
})

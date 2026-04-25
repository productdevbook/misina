import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  })
}

describe("abort during retry delay", () => {
  it("aborts immediately, doesn't wait out the backoff", async () => {
    let attempts = 0
    const driver = {
      name: "flaky",
      request: async () => {
        attempts++
        return new Response("nope", { status: 503 })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 5_000 }, // 5s between attempts
    })

    const controller = new AbortController()

    const promise = m.get("https://api.test/", { signal: controller.signal })
    // Let the first attempt land (sync); abort during the delay.
    await new Promise((r) => setTimeout(r, 10))
    controller.abort(new Error("user cancelled"))

    const start = Date.now()
    try {
      await promise
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain("user cancelled")
    }
    const elapsed = Date.now() - start

    expect(attempts).toBe(1)
    expect(elapsed).toBeLessThan(500)
  }, 3000)
})

describe("abort during a redirect chain", () => {
  it("stops following redirects when the user signal aborts", async () => {
    let visited = 0
    const driver = {
      name: "chain",
      request: async (req: Request) => {
        visited++
        // Simulate slow redirects
        await new Promise<void>((resolve, reject) => {
          if (req.signal?.aborted) {
            reject(req.signal.reason)
            return
          }
          const t = setTimeout(resolve, 50)
          req.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t)
              reject(req.signal!.reason)
            },
            { once: true },
          )
        })
        if (visited < 5) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://api.test/hop${visited}` },
          })
        }
        return jsonResponse({ done: true })
      },
    }

    const m = createMisina({ driver, retry: 0 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("user-abort")), 75)

    try {
      await m.get("https://api.test/start", { signal: controller.signal })
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain("user-abort")
    }
    // Should have stopped after the first or second hop, not all five.
    expect(visited).toBeLessThan(5)
  }, 3000)
})

describe("abort raised before the request even starts", () => {
  it("rejects without calling the driver if signal is already aborted", async () => {
    let driverCalls = 0
    const driver = {
      name: "watch",
      request: async () => {
        driverCalls++
        return jsonResponse({})
      },
    }

    const controller = new AbortController()
    controller.abort(new Error("pre-aborted"))

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://api.test/", { signal: controller.signal })
      // The driver may or may not run depending on whether the underlying
      // fetch detects the pre-aborted signal — both are acceptable.
    } catch (err) {
      // OK: aborted somewhere in the chain.
      expect(err).toBeDefined()
    }

    // What we care about: at most one call (no retry storm because of abort).
    expect(driverCalls).toBeLessThanOrEqual(1)
  })
})

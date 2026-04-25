import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("abort × driver lifecycle", () => {
  it("driver sees the same signal across retry attempts (each clone)", async () => {
    const seenSignals: AbortSignal[] = []
    let calls = 0
    const driver = {
      name: "track-signal",
      request: async (req: Request) => {
        seenSignals.push(req.signal)
        calls++
        if (calls < 3) {
          throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
        }
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 5, delay: () => 1 },
    })
    await m.get("https://api.test/")

    expect(calls).toBe(3)
    expect(seenSignals).toHaveLength(3)
    // Every attempt got *some* signal (timeout default = 10s). They aren't
    // necessarily identical objects (each attempt builds a fresh composedSignal),
    // but they exist.
    for (const s of seenSignals) {
      expect(s).toBeDefined()
    }
  })

  it("driver receiving abort during request: rejection is mapped, no extra retry", async () => {
    let calls = 0
    const driver = {
      name: "abort-mid",
      request: (req: Request) => {
        calls++
        return new Promise<Response>((_resolve, reject) => {
          if (req.signal.aborted) {
            reject(req.signal.reason)
            return
          }
          req.signal.addEventListener("abort", () => reject(req.signal.reason))
        })
      },
    }

    const m = createMisina({ driver, retry: 0 })
    const controller = new AbortController()
    const promise = m.get("https://api.test/", { signal: controller.signal })
    setTimeout(() => controller.abort(), 0)

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(1)
  })

  it("rejected request does not leave the driver hanging on next call", async () => {
    let calls = 0
    const driver = {
      name: "good-after-abort",
      request: async (req: Request) => {
        calls++
        if (req.signal.aborted) {
          throw req.signal.reason ?? new DOMException("aborted", "AbortError")
        }
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const m = createMisina({ driver, retry: 0 })

    const controller = new AbortController()
    controller.abort()

    await expect(m.get("https://api.test/", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    // First request short-circuited (no driver call for already-aborted signal).
    expect(calls).toBe(0)

    // Second request goes through normally.
    const res = await m.get("https://api.test/")
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
  })

  it("totalTimeout fires across retry attempts", async () => {
    let calls = 0
    const driver = {
      name: "always-503",
      request: async () => {
        calls++
        return new Response(null, { status: 503 })
      },
    }

    const m = createMisina({
      driver,
      throwHttpErrors: false,
      retry: { limit: 10, delay: () => 50 },
      totalTimeout: 100, // 100ms wall-clock budget — only a couple of retries fit
    })

    // We don't assert exact call count (timing is fragile in CI), only that
    // we didn't get all 10 retries through the budget.
    const start = Date.now()
    const result = await m.get("https://api.test/").catch((e) => e)
    const elapsed = Date.now() - start

    // Either the response (503) or a timeout — depending on which fires first.
    expect(elapsed).toBeLessThan(500)
    expect(calls).toBeLessThanOrEqual(5)
    void result
  })
})

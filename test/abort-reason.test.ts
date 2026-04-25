import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { TimeoutError } from "../src/index.ts"

describe("abort signals — reason propagation", () => {
  it("user-aborted request rejects without being mapped to TimeoutError", async () => {
    const driver = {
      name: "slow",
      request: (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          if (req.signal.aborted) {
            reject(req.signal.reason ?? new DOMException("aborted", "AbortError"))
            return
          }
          req.signal.addEventListener("abort", () => {
            reject(req.signal.reason ?? new DOMException("aborted", "AbortError"))
          })
        }),
    }

    const m = createMisina({ driver, retry: 0 })
    const controller = new AbortController()
    const promise = m.get("https://api.test/", { signal: controller.signal })
    // Schedule abort on the next tick so the driver has registered its listener.
    setTimeout(() => controller.abort(), 0)

    await expect(promise).rejects.toMatchObject({ name: "AbortError" })
    await expect(promise).rejects.not.toBeInstanceOf(TimeoutError)
  })

  it("user can abort with a custom reason — reason is reachable on the rejected error", async () => {
    const driver = {
      name: "slow",
      request: (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          if (req.signal.aborted) {
            reject(req.signal.reason)
            return
          }
          req.signal.addEventListener("abort", () => {
            reject(req.signal.reason)
          })
        }),
    }

    const m = createMisina({ driver, retry: 0 })
    const controller = new AbortController()
    const reason = new Error("user-cancelled-flow-3")
    const promise = m.get("https://api.test/", { signal: controller.signal })
    setTimeout(() => controller.abort(reason), 0)

    await expect(promise).rejects.toBe(reason)
  })

  it("our own timeout fires TimeoutError, not AbortError", async () => {
    const driver = {
      name: "slow",
      request: (req: Request) =>
        new Promise<Response>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            reject(req.signal.reason ?? new DOMException("aborted", "AbortError"))
          })
        }),
    }

    const m = createMisina({ driver, retry: 0, timeout: 20 })

    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(TimeoutError)
  })

  it("an already-aborted signal short-circuits before any driver call", async () => {
    let driverCalls = 0
    const driver = {
      name: "f",
      request: async () => {
        driverCalls++
        return new Response(null, { status: 200 })
      },
    }

    const m = createMisina({ driver, retry: 0 })
    const controller = new AbortController()
    controller.abort()

    await expect(m.get("https://api.test/", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(driverCalls).toBe(0)
  })

  it("abort during retry waiting cancels the retry, no further attempts", async () => {
    let calls = 0
    const driver = {
      name: "flaky",
      request: async (req: Request) => {
        calls++
        // First attempt fails network-like, retry should be scheduled.
        if (calls === 1) {
          throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
        }
        // Even if a 2nd attempt makes it through (it shouldn't), make sure
        // the signal is wired so the test fails loud rather than hanging.
        if (req.signal.aborted) {
          throw req.signal.reason
        }
        return new Response(null, { status: 200 })
      },
    }

    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 50 },
    })
    const controller = new AbortController()
    const promise = m.get("https://api.test/", { signal: controller.signal })

    // Wait long enough for the first failure + retry-scheduling, then abort.
    await new Promise((r) => setTimeout(r, 10))
    controller.abort(new Error("user-bail"))

    // The user's reason flows through directly — same contract as a non-retry
    // user abort (see "user can abort with a custom reason" above).
    await expect(promise).rejects.toThrowError("user-bail")
    // 1st attempt happens; 2nd should not (aborted before retryDelay finishes).
    expect(calls).toBe(1)
  })
})

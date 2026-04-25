import { describe, expect, it } from "vitest"
import { createMisina, defineDriver } from "../src/index.ts"

describe("timeout — user signal pass-through", () => {
  it("user signal abort propagates to driver", async () => {
    let driverSignal: AbortSignal | undefined
    const driver = defineDriver(() => ({
      name: "slow",
      request: (req) => {
        driverSignal = req.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          if (req.signal?.aborted) {
            reject(req.signal.reason)
            return
          }
          req.signal?.addEventListener(
            "abort",
            () => reject(req.signal!.reason ?? new Error("aborted")),
            { once: true },
          )
        })
      },
    }))()

    const m = createMisina({ driver, retry: 0, timeout: false })
    const controller = new AbortController()

    const promise = m.get("https://example.test/", { signal: controller.signal })
    // Give the request a tick to reach the driver
    await new Promise((r) => setTimeout(r, 5))
    controller.abort(new Error("user cancelled"))

    try {
      await promise
      throw new Error("should have thrown")
    } catch (err) {
      expect(driverSignal).toBeDefined()
      expect((err as Error).message).toContain("user cancelled")
    }
  }, 3000)
})

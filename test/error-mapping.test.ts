import { describe, expect, it } from "vitest"
import { createMisina, isNetworkError } from "../src/index.ts"

describe("mapTransportError — non-Error rejections", () => {
  it("driver rejecting with a string is propagated as-is", async () => {
    const driver = {
      name: "weird",
      request: async (): Promise<Response> => {
        throw "string error"
      },
    }

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBe("string error")
    }
  })

  it("driver rejecting with a DOMException AbortError preserves it", async () => {
    const driver = {
      name: "abort-driver",
      request: async (): Promise<Response> => {
        throw new DOMException("user clicked cancel", "AbortError")
      },
    }

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe("AbortError")
    }
  })

  it("driver rejecting with a TypeError fetch-style produces a NetworkError", async () => {
    const driver = {
      name: "broken",
      request: async (): Promise<Response> => {
        throw new TypeError("fetch failed")
      },
    }

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(isNetworkError(err)).toBe(true)
    }
  })

  it("driver rejecting with an arbitrary Error subclass passes through", async () => {
    class ServerCrash extends Error {
      override readonly name = "ServerCrash"
    }

    const driver = {
      name: "broken",
      request: async (): Promise<Response> => {
        throw new ServerCrash("kernel panic")
      },
    }

    const m = createMisina({ driver, retry: 0 })

    try {
      await m.get("https://api.test/")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ServerCrash)
      expect((err as Error).message).toBe("kernel panic")
    }
  })
})

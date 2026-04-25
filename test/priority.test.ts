import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

// Note: Node's Request implementation accepts `init.priority` per the WHATWG
// Fetch spec, but does not always expose it as a getter on the resulting
// Request. To verify pass-through we intercept the global Request constructor
// and observe the init bag misina builds.
describe("priority — RequestInit.priority passthrough", () => {
  it("misina forwards `priority` into the Request init bag", async () => {
    const NativeRequest = globalThis.Request
    const inits: RequestInit[] = []

    class WatchedRequest extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        if (init) inits.push(init)
        super(input, init)
      }
    }

    globalThis.Request = WatchedRequest as unknown as typeof Request
    try {
      const driver = {
        name: "p",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      }
      const m = createMisina({ driver, retry: 0, priority: "high" })
      await m.get("https://api.test/")
      const priorities = inits.map((i) => (i as RequestInit & { priority?: string }).priority)
      expect(priorities).toContain("high")
    } finally {
      globalThis.Request = NativeRequest
    }
  })

  it("per-request priority overrides defaults at the init bag", async () => {
    const NativeRequest = globalThis.Request
    const inits: RequestInit[] = []

    class WatchedRequest extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        if (init) inits.push(init)
        super(input, init)
      }
    }

    globalThis.Request = WatchedRequest as unknown as typeof Request
    try {
      const driver = {
        name: "p",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      }
      const m = createMisina({ driver, retry: 0, priority: "low" })
      await m.get("https://api.test/", { priority: "high" })
      const priorities = inits.map((i) => (i as RequestInit & { priority?: string }).priority)
      expect(priorities).toContain("high")
      expect(priorities).not.toContain("low")
    } finally {
      globalThis.Request = NativeRequest
    }
  })

  it("when not set, no init bag carries a priority", async () => {
    const NativeRequest = globalThis.Request
    const inits: RequestInit[] = []

    class WatchedRequest extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        if (init) inits.push(init)
        super(input, init)
      }
    }

    globalThis.Request = WatchedRequest as unknown as typeof Request
    try {
      const driver = {
        name: "p",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      }
      const m = createMisina({ driver, retry: 0 })
      await m.get("https://api.test/")
      for (const init of inits) {
        expect((init as RequestInit & { priority?: string }).priority).toBeUndefined()
      }
    } finally {
      globalThis.Request = NativeRequest
    }
  })
})

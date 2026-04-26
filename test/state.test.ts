import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

declare module "../src/types.ts" {
  interface MisinaState {
    counter?: number
    token?: string
  }
}

describe("state — session-scoped mutable shared object", () => {
  it("hooks see the same state reference across calls", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      state: { counter: 0 },
      hooks: {
        beforeRequest: (ctx) => {
          if (ctx.options.state.counter != null) {
            ctx.options.state.counter++
          }
        },
      },
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")
    await m.get("https://api.test/")

    // The state object is mutated by every call — read back via a hook
    // by triggering a final call and inspecting.
    let observed: number | undefined
    await m.get("https://api.test/", {
      hooks: {
        afterResponse: (ctx) => {
          observed = ctx.options.state.counter
        },
      },
    })
    expect(observed).toBe(4)
  })

  it("token rotation in hooks affects subsequent calls", async () => {
    let captured: (string | null)[] = []
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured.push(req.headers.get("authorization"))
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      state: { token: "v1" },
      hooks: {
        beforeRequest: (ctx) => {
          const headers = new Headers(ctx.request.headers)
          if (ctx.options.state.token)
            headers.set("authorization", `Bearer ${ctx.options.state.token}`)
          return new Request(ctx.request, { headers })
        },
      },
    })

    await m.get("https://api.test/")
    expect(captured[0]).toBe("Bearer v1")

    // Mutate state externally — next call uses the new token.
    await m.get("https://api.test/", {
      hooks: {
        init: (opts) => {
          opts.state.token = "v2"
        },
      },
    })
    expect(captured[1]).toBe("Bearer v2")
  })

  it("default empty {} when no state supplied", async () => {
    let captured: object | undefined
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          captured = ctx.options.state
        },
      },
    })

    await m.get("https://api.test/")
    expect(captured).toEqual({})
  })

  it(".extend() does NOT inherit parent state — child gets its own", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const parent = createMisina({
      driver,
      retry: 0,
      state: { counter: 100 },
    })
    const child = parent.extend({ state: { counter: 0 } })

    let parentObserved: number | undefined
    let childObserved: number | undefined
    await parent.get("https://api.test/", {
      hooks: {
        beforeRequest: (ctx) => {
          ctx.options.state.counter = (ctx.options.state.counter ?? 0) + 1
          parentObserved = ctx.options.state.counter
        },
      },
    })
    await child.get("https://api.test/", {
      hooks: {
        beforeRequest: (ctx) => {
          ctx.options.state.counter = (ctx.options.state.counter ?? 0) + 1
          childObserved = ctx.options.state.counter
        },
      },
    })

    expect(parentObserved).toBe(101)
    expect(childObserved).toBe(1) // child's state is fresh
  })

  it("state is the same reference across multiple calls on one instance", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const captured: object[] = []
    const m = createMisina({
      driver,
      retry: 0,
      state: { counter: 0 },
      hooks: {
        beforeRequest: (ctx) => {
          captured.push(ctx.options.state)
        },
      },
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")
    expect(captured[0]).toBe(captured[1]) // same reference
  })
})

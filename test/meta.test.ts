import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

declare module "../src/types.ts" {
  interface MisinaMeta {
    tag?: string
    tenant?: string
    requestId?: string
  }
}

describe("meta — per-request user data flows through hooks", () => {
  it("meta is reachable on ctx.options.meta in beforeRequest", async () => {
    let captured: { tag?: string; tenant?: string } | undefined
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          captured = { ...ctx.options.meta }
        },
      },
    })

    await m.get("https://api.test/users/42", { meta: { tag: "search", tenant: "acme" } })
    expect(captured).toEqual({ tag: "search", tenant: "acme" })
  })

  it("defaults meta + per-request meta merge (per-request wins)", async () => {
    let captured: { tag?: string; tenant?: string } | undefined
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      meta: { tenant: "default-tenant", tag: "all" },
      hooks: {
        beforeRequest: (ctx) => {
          captured = { ...ctx.options.meta }
        },
      },
    })

    await m.get("https://api.test/", { meta: { tag: "search" } })
    expect(captured).toEqual({ tenant: "default-tenant", tag: "search" })
  })

  it("meta is reachable in afterResponse", async () => {
    let captured: string | undefined
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        afterResponse: (ctx) => {
          captured = ctx.options.meta?.requestId
        },
      },
    })

    await m.get("https://api.test/", { meta: { requestId: "req-123" } })
    expect(captured).toBe("req-123")
  })

  it("no meta supplied → empty object", async () => {
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
          captured = ctx.options.meta
        },
      },
    })

    await m.get("https://api.test/")
    expect(captured).toEqual({})
  })

  it(".extend() merges meta with parent defaults", async () => {
    let captured: { tag?: string; tenant?: string } | undefined
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const parent = createMisina({
      driver,
      retry: 0,
      meta: { tenant: "parent-tenant", tag: "parent-tag" },
      hooks: {
        beforeRequest: (ctx) => {
          captured = { ...ctx.options.meta }
        },
      },
    })
    const child = parent.extend({ meta: { tag: "child-tag" } })

    await child.get("https://api.test/")
    expect(captured).toEqual({ tenant: "parent-tenant", tag: "child-tag" })
  })
})

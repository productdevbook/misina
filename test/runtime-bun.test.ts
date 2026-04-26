import "../src/runtime/bun/index.ts"

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("misina/runtime/bun — RequestInit pass-through", () => {
  it("forwards tls to ResolvedOptions (visible to hooks)", async () => {
    let observedTls: unknown
    const m = createMisina({
      driver: {
        name: "bun",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      },
      retry: 0,
      tls: { rejectUnauthorized: false, serverName: "internal.test" },
      hooks: {
        beforeRequest: (ctx) => {
          observedTls = (ctx.options as { tls?: unknown }).tls
        },
      },
    })
    await m.get("https://x.test/")
    expect(observedTls).toEqual({
      rejectUnauthorized: false,
      serverName: "internal.test",
    })
  })

  it("forwards unix / proxy / verbose", async () => {
    let observed: { unix?: unknown; proxy?: unknown; verbose?: unknown } = {}
    const m = createMisina({
      driver: {
        name: "bun",
        request: async () => new Response("{}"),
      },
      retry: 0,
      hooks: {
        beforeRequest: (ctx) => {
          const o = ctx.options as typeof observed
          observed = { unix: o.unix, proxy: o.proxy, verbose: o.verbose }
        },
      },
    })
    await m.get("https://x.test/", {
      unix: "/var/run/api.sock",
      proxy: "http://corp:3128",
      verbose: true,
    })
    expect(observed).toEqual({
      unix: "/var/run/api.sock",
      proxy: "http://corp:3128",
      verbose: true,
    })
  })

  it("typed augmentation accepts BunTlsOptions on createMisina", async () => {
    const driver = {
      name: "bun",
      request: async () => new Response("{}"),
    }
    const m = createMisina({ driver, retry: 0, tls: { rejectUnauthorized: false } })
    await expect(m.get("https://x.test/")).resolves.toBeDefined()
  })
})

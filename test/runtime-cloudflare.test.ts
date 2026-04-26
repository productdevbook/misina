import "../src/runtime/cloudflare/index.ts"

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("misina/runtime/cloudflare — cf RequestInit pass-through", () => {
  it("forwards cf to ResolvedOptions (visible to hooks)", async () => {
    let observedCf: unknown
    const m = createMisina({
      driver: {
        name: "cf",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      },
      retry: 0,
      cf: { cacheTtl: 300, cacheEverything: true },
      hooks: {
        beforeRequest: (ctx) => {
          observedCf = (ctx.options as { cf?: unknown }).cf
        },
      },
    })
    await m.get("https://x.test/")
    expect(observedCf).toEqual({ cacheTtl: 300, cacheEverything: true })
  })

  it("per-request cf overrides defaults.cf", async () => {
    let observedCf: unknown
    const m = createMisina({
      driver: {
        name: "cf",
        request: async () =>
          new Response("{}", { headers: { "content-type": "application/json" } }),
      },
      retry: 0,
      cf: { cacheTtl: 300 },
      hooks: {
        beforeRequest: (ctx) => {
          observedCf = (ctx.options as { cf?: unknown }).cf
        },
      },
    })
    await m.get("https://x.test/", { cf: { cacheTtl: 60 } })
    expect(observedCf).toEqual({ cacheTtl: 60 })
  })

  it("typed augmentation accepts CloudflareRequestProperties", async () => {
    const driver = {
      name: "cf",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })
    // Type-level assertion: this should compile cleanly with the
    // narrowed cf type once runtime/cloudflare is imported.
    const r = await m.get("https://x.test/", {
      cf: {
        cacheTtl: 60,
        cacheKey: "v1",
        cacheEverything: false,
        scrapeShield: true,
        polish: "lossless",
        image: { width: 800, fit: "contain", format: "auto" },
      },
    })
    expect(r.status).toBe(200)
  })
})

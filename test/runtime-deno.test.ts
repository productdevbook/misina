import "../src/runtime/deno/index.ts"

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("misina/runtime/deno — client RequestInit pass-through", () => {
  it("forwards client to ResolvedOptions (visible to hooks)", async () => {
    let observed: unknown
    const fakeClient = { close: () => {} }
    const m = createMisina({
      driver: {
        name: "deno",
        request: async () => new Response("{}"),
      },
      retry: 0,
      client: fakeClient,
      hooks: {
        beforeRequest: (ctx) => {
          observed = (ctx.options as { client?: unknown }).client
        },
      },
    })
    await m.get("https://x.test/")
    expect(observed).toBe(fakeClient)
  })

  it("per-request client overrides defaults.client", async () => {
    let observed: unknown
    const a = { close: () => {} }
    const b = { close: () => {} }
    const m = createMisina({
      driver: {
        name: "deno",
        request: async () => new Response("{}"),
      },
      retry: 0,
      client: a,
      hooks: {
        beforeRequest: (ctx) => {
          observed = (ctx.options as { client?: unknown }).client
        },
      },
    })
    await m.get("https://x.test/", { client: b })
    expect(observed).toBe(b)
  })
})

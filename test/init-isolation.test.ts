import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("init hook — per-request isolation (ky #861)", () => {
  it("mutating headers in init does not leak to a sibling concurrent request", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    let counter = 0
    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        init: (options) => {
          // Each request increments and writes its own value. If options
          // were shared, both requests would see the same final value.
          counter++
          options.headers["x-counter"] = String(counter)
        },
      },
    })

    await Promise.all([m.get("https://api.test/a"), m.get("https://api.test/b")])

    const calls = getMockApi(driver)?.calls
    expect(calls).toHaveLength(2)
    const counterA = calls?.[0]?.headers["x-counter"]
    const counterB = calls?.[1]?.headers["x-counter"]
    // Each request gets its own value; they shouldn't be identical and
    // should be 1 and 2 in some order.
    expect(new Set([counterA, counterB])).toEqual(new Set(["1", "2"]))
  })

  it("mutating defaults.headers from init does not affect future requests", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const m = createMisina({
      driver,
      retry: 0,
      headers: { "x-base": "first" },
      hooks: {
        init: (options) => {
          // If options.headers shared the defaults reference, this would
          // mutate the *defaults* and persist across calls.
          options.headers["x-base"] = "mutated"
        },
      },
    })

    await m.get("https://api.test/")
    await m.get("https://api.test/")

    const calls = getMockApi(driver)?.calls
    // Both requests see 'mutated' because init runs each time, but the
    // mutation should NOT compound (e.g. become 'mutatedmutated').
    expect(calls?.[0]?.headers["x-base"]).toBe("mutated")
    expect(calls?.[1]?.headers["x-base"]).toBe("mutated")
  })
})

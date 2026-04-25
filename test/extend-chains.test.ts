import { describe, expect, it } from "vitest"
import { createMisina, replaceOption } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe(".extend() — deep chains", () => {
  it("grandchild inherits headers from grandparent and parent (last wins)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const grandparent = createMisina({
      driver,
      retry: 0,
      headers: { "x-tier": "free", "x-region": "us" },
    })
    const parent = grandparent.extend({
      headers: { "x-tier": "pro" }, // override
    })
    const child = parent.extend({
      headers: { "x-feature": "beta" }, // additional
    })

    await child.get("https://api.test/")

    const headers = getMockApi(driver)?.calls[0]?.headers
    expect(headers?.["x-tier"]).toBe("pro")
    expect(headers?.["x-region"]).toBe("us")
    expect(headers?.["x-feature"]).toBe("beta")
  })

  it("hooks accumulate across three levels of extend", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const grandparent = createMisina({
      driver,
      retry: 0,
      hooks: { beforeRequest: () => void order.push("gp") },
    })
    const parent = grandparent.extend({
      hooks: { beforeRequest: () => void order.push("p") },
    })
    const child = parent.extend({
      hooks: { beforeRequest: () => void order.push("c") },
    })

    await child.get("https://api.test/")
    expect(order).toEqual(["gp", "p", "c"])
  })

  it("replaceOption() in a child wipes parent + grandparent hooks", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const order: string[] = []

    const grandparent = createMisina({
      driver,
      retry: 0,
      hooks: { beforeRequest: () => void order.push("gp") },
    })
    const parent = grandparent.extend({
      hooks: { beforeRequest: () => void order.push("p") },
    })
    const child = parent.extend({
      hooks: replaceOption({ beforeRequest: () => void order.push("only-c") }),
    })

    await child.get("https://api.test/")
    expect(order).toEqual(["only-c"])
  })

  it("function-form extend reads merged-up-to-now defaults (parent is grandparent + parent)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const grandparent = createMisina({
      driver,
      retry: 0,
      baseURL: "https://api.test/v1",
    })
    const parent = grandparent.extend({ baseURL: "https://api.test/v2" })

    const seen: { baseURL: string | undefined }[] = []
    const child = parent.extend((p) => {
      seen.push({ baseURL: p.baseURL })
      return { baseURL: p.baseURL?.replace("/v2", "/v3") }
    })

    await child.get("hello")
    // function received parent's resolved baseURL (v2 after override).
    expect(seen[0]?.baseURL).toBe("https://api.test/v2")
    expect(getMockApi(driver)?.calls[0]?.url).toBe("https://api.test/v3/hello")
  })

  it("retry settings are replaced (number) but otherwise merged (object)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })

    const parent = createMisina({
      driver,
      retry: { limit: 3, delay: () => 10 },
    })

    // child overrides limit but keeps the parent's delay function
    const child = parent.extend({ retry: { limit: 1 } })

    // Race: child should retry exactly once.
    let calls = 0
    const flaky = {
      name: "flaky",
      request: async () => {
        calls++
        return calls < 5 ? new Response("nope", { status: 503 }) : jsonResponse({ ok: true })
      },
    }

    const flakyChild = createMisina({ driver: flaky, retry: 0 }).extend({
      retry: { limit: 1, delay: () => 0 },
    })

    void parent
    void child

    await expect(flakyChild.get("https://api.test/")).rejects.toThrow()
    expect(calls).toBe(2) // initial + 1 retry
  })
})

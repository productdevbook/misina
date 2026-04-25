import { describe, expect, it } from "vitest"
import { createMisina, defineDriver } from "../src/index.ts"

describe("redirect — manual mode (default)", () => {
  it("follows 302 to a same-origin URL preserving headers", async () => {
    const seen: { url: string; auth: string | null }[] = []

    const driver = defineDriver(() => ({
      name: "redirect-server",
      request: async (req) => {
        seen.push({ url: req.url, auth: req.headers.get("authorization") })

        if (req.url === "https://example.test/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.test/dest" },
          })
        }
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }))()

    const m = createMisina({
      driver,
      retry: 0,
      headers: { Authorization: "Bearer secret" },
    })

    await m.get("https://example.test/start")

    expect(seen).toHaveLength(2)
    expect(seen[1]?.url).toBe("https://example.test/dest")
    expect(seen[1]?.auth).toBe("Bearer secret")
  })

  it("strips Authorization on cross-origin 302", async () => {
    const seen: { url: string; auth: string | null }[] = []

    const driver = defineDriver(() => ({
      name: "redirect-server",
      request: async (req) => {
        seen.push({ url: req.url, auth: req.headers.get("authorization") })

        if (req.url === "https://api.example.test/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/steal" },
          })
        }
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }))()

    const m = createMisina({
      driver,
      retry: 0,
      headers: { Authorization: "Bearer secret" },
    })

    await m.get("https://api.example.test/start")

    expect(seen).toHaveLength(2)
    expect(seen[1]?.url).toBe("https://attacker.example/steal")
    expect(seen[1]?.auth).toBeNull()
  })

  it("blocks https → http downgrade by default", async () => {
    const driver = defineDriver(() => ({
      name: "downgrade-server",
      request: async () => {
        return new Response(null, {
          status: 302,
          headers: { location: "http://insecure.example/" },
        })
      },
    }))()

    const m = createMisina({ driver, retry: 0 })

    await expect(m.get("https://example.test/")).rejects.toThrow(/https → http/)
  })

  it("calls beforeRedirect hook before following", async () => {
    let hookCalled = false
    let sameOriginSeen: boolean | undefined

    const driver = defineDriver(() => ({
      name: "redirect-server",
      request: async (req) => {
        if (req.url === "https://api.example.test/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example/" },
          })
        }
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }))()

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRedirect: ({ sameOrigin }) => {
          hookCalled = true
          sameOriginSeen = sameOrigin
        },
      },
    })

    await m.get("https://api.example.test/start")

    expect(hookCalled).toBe(true)
    expect(sameOriginSeen).toBe(false)
  })

  it("throws on too many redirects", async () => {
    const driver = defineDriver(() => ({
      name: "loop-server",
      request: async () => {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/loop" },
        })
      },
    }))()

    const m = createMisina({ driver, retry: 0, redirectMaxCount: 3 })

    await expect(m.get("https://example.test/loop")).rejects.toThrow(/too many redirects/)
  })
})

describe("redirect — error mode", () => {
  it("throws when a 3xx is returned", async () => {
    const driver = defineDriver(() => ({
      name: "redirect-server",
      request: async () => {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.test/dest" },
        })
      },
    }))()

    const m = createMisina({ driver, retry: 0, redirect: "error" })

    await expect(m.get("https://example.test/")).rejects.toThrow(/redirect/i)
  })
})

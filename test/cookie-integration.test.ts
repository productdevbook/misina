import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { MemoryCookieJar, withCookieJar } from "../src/cookie/index.ts"

describe("withCookieJar — integration with misina lifecycle", () => {
  it("captures multiple Set-Cookie headers via getSetCookie", async () => {
    const driver = {
      name: "multi-set-cookie",
      request: async (req: Request) => {
        if (req.url.endsWith("/login")) {
          // The standard Headers polyfill in Node 22+ supports `getSetCookie()`.
          // Stack two Set-Cookie headers.
          const headers = new Headers()
          headers.append("set-cookie", "session=abc; Path=/")
          headers.append("set-cookie", "csrf=xyz; Path=/")
          return new Response(null, { status: 200, headers })
        }
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") }), {
          headers: { "content-type": "application/json" },
        })
      },
    }

    const jar = new MemoryCookieJar()
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)

    await m.get("https://api.test/login")
    const res = await m.get<{ cookie: string }>("https://api.test/profile")

    // Both cookies survive the round trip — order isn't guaranteed but both
    // must be present.
    expect(res.data.cookie).toContain("session=abc")
    expect(res.data.cookie).toContain("csrf=xyz")
  })

  it("expired cookie (Max-Age in the past) is not sent", async () => {
    const driver = {
      name: "expirer",
      request: async (req: Request) => {
        if (req.url.endsWith("/set")) {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "old=1; Max-Age=-1; Path=/" },
          })
        }
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") ?? "" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }

    const jar = new MemoryCookieJar()
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)

    await m.get("https://api.test/set")
    const res = await m.get<{ cookie: string }>("https://api.test/check")
    expect(res.data.cookie).toBe("")
  })

  it("cookies are isolated by host (no leak to other.test)", async () => {
    const driver = {
      name: "host-iso",
      request: async (req: Request) => {
        if (req.url === "https://api.test/login") {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "session=abc; Path=/" },
          })
        }
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") ?? "" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }

    const jar = new MemoryCookieJar()
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)

    await m.get("https://api.test/login")
    const same = await m.get<{ cookie: string }>("https://api.test/x")
    const other = await m.get<{ cookie: string }>("https://other.test/x")
    expect(same.data.cookie).toBe("session=abc")
    expect(other.data.cookie).toBe("")
  })

  it("user-supplied Cookie header is preserved alongside jar cookies", async () => {
    let captured: string | null = null
    const driver = {
      name: "watch",
      request: async (req: Request) => {
        if (req.url.endsWith("/login")) {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "from-server=A; Path=/" },
          })
        }
        captured = req.headers.get("cookie")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const jar = new MemoryCookieJar()
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)

    await m.get("https://api.test/login")
    await m.get("https://api.test/x", { headers: { cookie: "from-user=B" } })

    // Both cookies should be present, separated by "; ".
    expect(captured).toBeTruthy()
    expect(captured).toContain("from-user=B")
    expect(captured).toContain("from-server=A")
  })

  it("Path-scoped cookie is not sent to a non-matching path", async () => {
    let captured: string | null = null
    const driver = {
      name: "pathy",
      request: async (req: Request) => {
        if (req.url.endsWith("/api/login")) {
          return new Response(null, {
            status: 200,
            headers: { "set-cookie": "session=abc; Path=/api/" },
          })
        }
        captured = req.headers.get("cookie")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const jar = new MemoryCookieJar()
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)

    await m.get("https://api.test/api/login")
    await m.get("https://api.test/other/page")
    expect(captured).toBeNull()

    await m.get("https://api.test/api/profile")
    expect(captured).toBe("session=abc")
  })
})

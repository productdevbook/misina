import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { MemoryCookieJar, withCookieJar } from "../src/cookie/index.ts"

describe("withCookieJar — redirect persistence (undici #3784 parity)", () => {
  it("captures Set-Cookie issued by an intermediate redirect hop", async () => {
    const jar = new MemoryCookieJar()
    let call = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        call++
        if (call === 1) {
          // Step 1: server sets session cookie and 302's us to /home.
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://api.test/home",
              "set-cookie": "session=abc123; Path=/",
            },
          })
        }
        // Step 2: server checks the Cookie header it sees on the
        // redirect target. We assert via response body so the test
        // can read it after.
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)
    const result = await m.get<{ cookie: string }>("https://api.test/login")
    expect(result.data.cookie).toBe("session=abc123")
    // Jar persisted the cookie from the intermediate hop.
    const stored = await jar.getCookieString("https://api.test/")
    expect(stored).toBe("session=abc123")
  })

  it("layers cookies from multiple redirect hops in arrival order", async () => {
    const jar = new MemoryCookieJar()
    let call = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        call++
        if (call === 1) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://api.test/two",
              "set-cookie": "a=1; Path=/",
            },
          })
        }
        if (call === 2) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://api.test/three",
              "set-cookie": "b=2; Path=/",
            },
          })
        }
        return new Response(JSON.stringify({ cookie: req.headers.get("cookie") }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)
    const result = await m.get<{ cookie: string }>("https://api.test/one")
    // Both cookies sent on the third hop.
    expect(result.data.cookie).toContain("a=1")
    expect(result.data.cookie).toContain("b=2")
  })

  it("still picks up Set-Cookie on the terminal (non-redirect) response", async () => {
    const jar = new MemoryCookieJar()
    const driver = {
      name: "x",
      request: async () =>
        new Response("ok", {
          status: 200,
          headers: { "set-cookie": "session=zzz; Path=/" },
        }),
    }
    const m = withCookieJar(createMisina({ driver, retry: 0 }), jar)
    await m.get("https://api.test/")
    expect(await jar.getCookieString("https://api.test/")).toBe("session=zzz")
  })
})

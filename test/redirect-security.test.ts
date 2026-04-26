import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("redirect security — sensitive header stripping", () => {
  it("strips Cookie on cross-origin redirect", async () => {
    const seen: { url: string; cookie: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({ url: req.url, cookie: req.headers.get("cookie") })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      headers: { Cookie: "session=secret" },
    })

    await m.get("https://api.example.com/start")

    expect(seen).toHaveLength(2)
    expect(seen[0]?.cookie).toBe("session=secret")
    expect(seen[1]?.cookie).toBeNull()
  })

  it("strips Proxy-Authorization on cross-origin redirect", async () => {
    const seen: { url: string; pa: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          pa: req.headers.get("proxy-authorization"),
        })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      headers: { "proxy-authorization": "Basic stuff" },
    })

    await m.get("https://api.example.com/start")
    expect(seen[1]?.pa).toBeNull()
  })

  it("preserves whitelisted headers via redirectSafeHeaders", async () => {
    const seen: { url: string; ua: string | null; trace: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          ua: req.headers.get("user-agent"),
          trace: req.headers.get("x-trace"),
        })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      headers: { "user-agent": "misina-test", "x-trace": "abc" },
      redirectSafeHeaders: ["accept", "user-agent", "x-trace"],
    })

    await m.get("https://api.example.com/start")
    expect(seen[1]?.ua).toBe("misina-test")
    expect(seen[1]?.trace).toBe("abc")
  })

  it("a non-listed header is dropped on cross-origin even if user requested it as safe-by-default", async () => {
    const seen: { url: string; custom: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          custom: req.headers.get("x-custom"),
        })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      headers: { "x-custom": "v" },
      // Default safe list excludes x-custom — it should be dropped on cross-origin.
    })

    await m.get("https://api.example.com/start")
    expect(seen[1]?.custom).toBeNull()
  })
})

describe("redirect — redirectMaxCount enforcement", () => {
  it("throws after the configured cap", async () => {
    const driver = {
      name: "loop",
      request: async (req: Request) => {
        // Keep returning a redirect to a fresh path so cycle detection
        // (URL repeat) doesn't kick in.
        const m = /loop\/(\d+)/.exec(req.url)
        const n = m ? Number(m[1]) + 1 : 1
        return new Response(null, {
          status: 302,
          headers: { location: `https://api.test/loop/${n}` },
        })
      },
    }

    const m = createMisina({ driver, retry: 0, redirectMaxCount: 3 })

    await expect(m.get("https://api.test/loop/0")).rejects.toThrow(/too many redirects/)
  })
})

describe("redirect — https → http downgrade refused", () => {
  it("default config refuses the downgrade", async () => {
    const driver = {
      name: "downgrader",
      request: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://insecure.test/" },
        }),
    }

    const m = createMisina({ driver, retry: 0 })
    await expect(m.get("https://api.test/")).rejects.toThrow(/https → http/)
  })

  it("redirectAllowDowngrade: true permits it", async () => {
    const seen: string[] = []
    const driver = {
      name: "downgrader",
      request: async (req: Request) => {
        seen.push(req.url)
        if (req.url.startsWith("https://")) {
          return new Response(null, {
            status: 302,
            headers: { location: "http://insecure.test/" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({ driver, retry: 0, redirectAllowDowngrade: true })
    await m.get("https://api.test/")

    expect(seen[1]).toBe("http://insecure.test/")
  })
})

describe("beforeRedirect hook — receives prepared next request", () => {
  it("hook can inspect and replace the next request", async () => {
    const seen: { url: string; xtouched: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({ url: req.url, xtouched: req.headers.get("x-touched") })
        if (req.url === "https://api.test/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://api.test/dest" },
          })
        }
        return jsonResponse({})
      },
    }

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRedirect: ({ request }) => {
          const headers = new Headers(request.headers)
          headers.set("x-touched", "yes")
          return new Request(request, { headers })
        },
      },
    })

    await m.get("https://api.test/start")
    expect(seen[1]?.xtouched).toBe("yes")
  })

  it("strips Signature + Signature-Input by default on cross-origin redirect", async () => {
    const seen: { url: string; sig: string | null; sigIn: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          sig: req.headers.get("signature"),
          sigIn: req.headers.get("signature-input"),
        })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      headers: { Signature: "sig=:abc:", "Signature-Input": "sig=();keyid=k1" },
    })
    await m.get("https://api.example.com/start")
    expect(seen[0]?.sig).toBe("sig=:abc:")
    expect(seen[1]?.sig).toBeNull()
    expect(seen[1]?.sigIn).toBeNull()
  })

  it("strips user-supplied redirectStripHeaders on cross-origin redirect", async () => {
    const seen: { url: string; apiKey: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({ url: req.url, apiKey: req.headers.get("x-api-key") })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://other.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      headers: { "X-Api-Key": "secret-123" },
      redirectStripHeaders: ["x-api-key"],
    })
    await m.get("https://api.example.com/start")
    expect(seen[0]?.apiKey).toBe("secret-123")
    expect(seen[1]?.apiKey).toBeNull()
  })

  it("redirectStripHeaders also applies to same-origin redirects", async () => {
    const seen: { url: string; apiKey: string | null }[] = []
    const driver = {
      name: "redirector",
      request: async (req: Request) => {
        seen.push({ url: req.url, apiKey: req.headers.get("x-api-key") })
        if (req.url === "https://api.example.com/start") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://api.example.com/dest" },
          })
        }
        return jsonResponse({})
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      headers: { "X-Api-Key": "secret-123" },
      redirectStripHeaders: ["x-api-key"],
    })
    await m.get("https://api.example.com/start")
    expect(seen[0]?.apiKey).toBe("secret-123")
    expect(seen[1]?.apiKey).toBeNull()
  })
})

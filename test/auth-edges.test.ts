import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { withBasic, withBearer, withCsrf, withRefreshOn401 } from "../src/auth/index.ts"

function recordingDriver() {
  const seen: { url: string; auth: string | null; csrf: string | null }[] = []
  return {
    seen,
    driver: {
      name: "rec",
      request: async (req: Request) => {
        seen.push({
          url: req.url,
          auth: req.headers.get("authorization"),
          csrf: req.headers.get("x-xsrf-token"),
        })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    },
  }
}

describe("withBearer — token edge cases", () => {
  it("empty token: header is not set", async () => {
    const { seen, driver } = recordingDriver()
    const m = withBearer(createMisina({ driver, retry: 0 }), "")
    await m.get("https://api.test/")
    expect(seen[0]?.auth).toBeNull()
  })

  it("function returning empty: header is not set", async () => {
    const { seen, driver } = recordingDriver()
    const m = withBearer(createMisina({ driver, retry: 0 }), () => "")
    await m.get("https://api.test/")
    expect(seen[0]?.auth).toBeNull()
  })

  it("async function source: token resolved per-request", async () => {
    const { seen, driver } = recordingDriver()
    let n = 0
    const m = withBearer(createMisina({ driver, retry: 0 }), async () => `t${++n}`)
    await m.get("https://api.test/a")
    await m.get("https://api.test/b")
    expect(seen[0]?.auth).toBe("Bearer t1")
    expect(seen[1]?.auth).toBe("Bearer t2")
  })

  it("user-supplied auth header is overridden by withBearer", async () => {
    const { seen, driver } = recordingDriver()
    const m = withBearer(createMisina({ driver, retry: 0 }), "from-bearer")
    await m.get("https://api.test/", { headers: { authorization: "from-call" } })
    expect(seen[0]?.auth).toBe("Bearer from-bearer")
  })
})

describe("withBasic — encoding edges", () => {
  it("ASCII credentials encode correctly", async () => {
    const { seen, driver } = recordingDriver()
    const m = withBasic(createMisina({ driver, retry: 0 }), "alice", "secret")
    await m.get("https://api.test/")
    // base64("alice:secret") = "YWxpY2U6c2VjcmV0"
    expect(seen[0]?.auth).toBe("Basic YWxpY2U6c2VjcmV0")
  })

  it("non-ASCII (Turkish chars) credentials encode as UTF-8, not Latin1", async () => {
    const { seen, driver } = recordingDriver()
    // "şifre" — has a non-Latin1 char, would crash naive btoa.
    const m = withBasic(createMisina({ driver, retry: 0 }), "kullanıcı", "şifre")
    await m.get("https://api.test/")
    // Decode back via atob → bytes → utf8 string.
    const auth = seen[0]?.auth ?? ""
    const b64 = auth.replace(/^Basic /, "")
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const decoded = new TextDecoder().decode(bytes)
    expect(decoded).toBe("kullanıcı:şifre")
  })

  it("function-form credentials are resolved per request", async () => {
    const { seen, driver } = recordingDriver()
    let i = 0
    const m = withBasic(
      createMisina({ driver, retry: 0 }),
      () => `user${++i}`,
      () => "pwd",
    )
    await m.get("https://api.test/a")
    await m.get("https://api.test/b")
    expect(seen[0]?.auth).not.toBe(seen[1]?.auth)
  })
})

describe("withCsrf — cookie patterns", () => {
  it("reads token from cookie and sets header", async () => {
    const { seen, driver } = recordingDriver()
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      getCookies: () => "XSRF-TOKEN=abc123; sessionid=xyz",
    })
    await m.get("https://api.test/")
    expect(seen[0]?.csrf).toBe("abc123")
  })

  it("URL-encoded cookie value is decoded", async () => {
    const { seen, driver } = recordingDriver()
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      getCookies: () => "XSRF-TOKEN=token%2Bwith%3Dpadding",
    })
    await m.get("https://api.test/")
    expect(seen[0]?.csrf).toBe("token+with=padding")
  })

  it("missing cookie: header not set", async () => {
    const { seen, driver } = recordingDriver()
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      getCookies: () => "irrelevant=value",
    })
    await m.get("https://api.test/")
    expect(seen[0]?.csrf).toBeNull()
  })

  it("cookie name with regex metacharacters is escaped", async () => {
    const { seen, driver } = recordingDriver()
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      cookieName: "csrf.token+v2",
      getCookies: () => "csrf.token+v2=safe",
    })
    await m.get("https://api.test/")
    expect(seen[0]?.csrf).toBe("safe")
  })

  it("custom header name works", async () => {
    let xsrfHeader: string | null = null
    const driver = {
      name: "custom",
      request: async (req: Request) => {
        xsrfHeader = req.headers.get("x-csrf-token")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      headerName: "X-CSRF-Token",
      getCookies: () => "XSRF-TOKEN=abc",
    })
    await m.get("https://api.test/")
    expect(xsrfHeader).toBe("abc")
  })

  it("getCookies throwing is gracefully handled", async () => {
    const { seen, driver } = recordingDriver()
    const m = withCsrf(createMisina({ driver, retry: 0 }), {
      getCookies: () => {
        throw new Error("no document")
      },
    })
    // Must not throw — request goes through without csrf header.
    await m.get("https://api.test/")
    expect(seen[0]?.csrf).toBeNull()
  })
})

describe("withRefreshOn401 — additional edges", () => {
  it("Bearer is replaced after refresh, even if app supplies its own auth header", async () => {
    let attempts = 0
    const driver = {
      name: "rotating",
      request: async (req: Request) => {
        attempts++
        const auth = req.headers.get("authorization")
        if (attempts === 1) {
          // First call rejected
          return new Response(null, { status: 401 })
        }
        // Refreshed call: auth header should be the new value
        if (auth === "Bearer NEW") {
          return new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(null, { status: 403 })
      },
    }

    const misina = createMisina({ driver, retry: 0 })
    const api = withRefreshOn401(misina, { refresh: () => "NEW" })

    const res = await api.get<{ ok: boolean }>("https://api.test/", {
      headers: { authorization: "Bearer OLD" },
    })
    expect(res.data.ok).toBe(true)
    expect(attempts).toBe(2)
  })

  it("custom shouldRefresh predicate triggers refresh on 419 (Laravel)", async () => {
    let attempts = 0
    const driver = {
      name: "419",
      request: async () => {
        attempts++
        if (attempts === 1) return new Response(null, { status: 419 })
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const misina = createMisina({ driver, retry: 0 })
    const api = withRefreshOn401(misina, {
      refresh: () => "NEW",
      shouldRefresh: (ctx) => ctx.response?.status === 419,
    })

    const res = await api.get("https://api.test/")
    expect(res.status).toBe(200)
    expect(attempts).toBe(2)
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { createPkcePair, exchangePkceCode, peekJwtExp, withJwtRefresh } from "../src/auth/oauth.ts"

function makeJwt(payload: Record<string, unknown>): string {
  // Header doesn't matter for peekJwtExp; signature segment can be empty.
  const enc = (obj: unknown): string =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${enc({ alg: "none" })}.${enc(payload)}.`
}

describe("peekJwtExp", () => {
  it("returns the exp claim", () => {
    const t = makeJwt({ exp: 1_700_000_000 })
    expect(peekJwtExp(t)).toBe(1_700_000_000)
  })

  it("returns null for non-JWT strings", () => {
    expect(peekJwtExp("not-a-jwt")).toBeNull()
    expect(peekJwtExp("a.b")).toBeNull() // valid 2-segment shape but b isn't valid base64
    expect(peekJwtExp("")).toBeNull()
  })

  it("returns null when exp is missing", () => {
    expect(peekJwtExp(makeJwt({ sub: "x" }))).toBeNull()
  })
})

describe("withJwtRefresh", () => {
  it("refreshes proactively when the JWT is about to expire", async () => {
    const expiringExp = Math.floor(Date.now() / 1000) + 5 // 5s left
    let token = makeJwt({ exp: expiringExp })
    let refreshes = 0
    let observedAuth: string | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        observedAuth = req.headers.get("authorization") ?? undefined
        return new Response("ok", { status: 200 })
      },
    }
    const m = withJwtRefresh(createMisina({ driver, retry: 0 }), {
      getToken: () => token,
      refresh: async () => {
        refreshes++
        token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
        return token
      },
      expiryWindowMs: 30_000, // refresh anything < 30s left
    })
    await m.get("https://x.test/", { headers: { authorization: `Bearer ${token}` } })
    expect(refreshes).toBe(1)
    expect(observedAuth).toBe(`Bearer ${token}`)
  })

  it("does not refresh when the token is still fresh", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    let refreshes = 0
    const driver = {
      name: "x",
      request: async () => new Response("ok", { status: 200 }),
    }
    const m = withJwtRefresh(createMisina({ driver, retry: 0 }), {
      getToken: () => token,
      refresh: async () => {
        refreshes++
        return token
      },
    })
    await m.get("https://x.test/", { headers: { authorization: `Bearer ${token}` } })
    expect(refreshes).toBe(0)
  })

  it("collapses concurrent refreshes onto a single call (single-flight)", async () => {
    const expiring = Math.floor(Date.now() / 1000) + 5
    let token = makeJwt({ exp: expiring })
    let refreshes = 0
    const driver = {
      name: "x",
      request: async () => new Response("ok", { status: 200 }),
    }
    const m = withJwtRefresh(createMisina({ driver, retry: 0 }), {
      getToken: () => token,
      refresh: async () => {
        refreshes++
        await new Promise((r) => setTimeout(r, 5))
        token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
        return token
      },
      expiryWindowMs: 30_000,
    })
    await Promise.all([
      m.get("https://x.test/a", { headers: { authorization: `Bearer ${token}` } }),
      m.get("https://x.test/b", { headers: { authorization: `Bearer ${token}` } }),
      m.get("https://x.test/c", { headers: { authorization: `Bearer ${token}` } }),
    ])
    expect(refreshes).toBe(1)
  })

  it("rejects when refresh returns the same token", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 5 })
    const driver = {
      name: "x",
      request: async () => new Response("ok", { status: 200 }),
    }
    const m = withJwtRefresh(createMisina({ driver, retry: 0 }), {
      getToken: () => token,
      refresh: () => token, // unchanged — bug scenario
    })
    await expect(
      m.get("https://x.test/", { headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toThrow(/same token/)
  })
})

describe("createPkcePair", () => {
  it("generates a valid verifier (43 chars, base64url alphabet)", async () => {
    const pair = await createPkcePair()
    expect(pair.method).toBe("S256")
    expect(pair.verifier.length).toBe(43)
    expect(/^[A-Za-z0-9_-]+$/.test(pair.verifier)).toBe(true)
  })

  it("challenge equals base64url(SHA-256(verifier))", async () => {
    const pair = await createPkcePair()
    const subtle = globalThis.crypto.subtle
    const expected = await subtle.digest("SHA-256", new TextEncoder().encode(pair.verifier))
    const expectedB64 = btoa(String.fromCharCode(...new Uint8Array(expected)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(pair.challenge).toBe(expectedB64)
  })

  it("each call produces a unique pair", async () => {
    const a = await createPkcePair()
    const b = await createPkcePair()
    expect(a.verifier).not.toBe(b.verifier)
  })
})

describe("exchangePkceCode", () => {
  it("posts the standard token-exchange body to the token endpoint", async () => {
    let captured: { url: string; body: URLSearchParams } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        const text = await req.text()
        captured = { url: req.url, body: new URLSearchParams(text) }
        return new Response(
          JSON.stringify({
            access_token: "AT",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "RT",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const tokens = await exchangePkceCode(m, {
      tokenEndpoint: "https://idp.test/token",
      clientId: "abc",
      redirectUri: "https://app.test/cb",
      code: "AUTHCODE",
      verifier: "VERIFIER",
    })
    expect(tokens.access_token).toBe("AT")
    expect(tokens.refresh_token).toBe("RT")
    expect(captured?.url).toBe("https://idp.test/token")
    expect(captured?.body.get("grant_type")).toBe("authorization_code")
    expect(captured?.body.get("code")).toBe("AUTHCODE")
    expect(captured?.body.get("code_verifier")).toBe("VERIFIER")
    expect(captured?.body.get("client_id")).toBe("abc")
    expect(captured?.body.get("redirect_uri")).toBe("https://app.test/cb")
  })

  it("includes client_secret for confidential clients", async () => {
    let captured: URLSearchParams | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = new URLSearchParams(await req.text())
        return new Response('{"access_token":"a","token_type":"Bearer"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await exchangePkceCode(m, {
      tokenEndpoint: "https://idp.test/token",
      clientId: "id",
      redirectUri: "https://app.test/cb",
      code: "C",
      verifier: "V",
      clientSecret: "shh",
    })
    expect(captured?.get("client_secret")).toBe("shh")
  })
})

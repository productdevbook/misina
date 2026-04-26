import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { digestAuth, DigestMismatchError, verifyDigest } from "../src/digest/index.ts"

// RFC 9530 §6 example: sha-256 of `{"hello": "world"}` (with the
// space) is X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=
const RFC9530_BODY = '{"hello": "world"}'
const RFC9530_SHA256 = "X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE="

describe("digestAuth — outgoing", () => {
  it("adds Content-Digest with the RFC 9530 §6 sha-256 vector", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth()] })
    await m.post("https://x.test/", RFC9530_BODY, {
      headers: { "content-type": "application/json" },
    })
    expect(captured?.get("content-digest")).toBe(`sha-256=:${RFC9530_SHA256}:`)
  })

  it("uses Repr-Digest when configured", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth({ field: "repr-digest" })] })
    await m.post("https://x.test/", RFC9530_BODY, {
      headers: { "content-type": "application/json" },
    })
    expect(captured?.get("repr-digest")).toBe(`sha-256=:${RFC9530_SHA256}:`)
    expect(captured?.get("content-digest")).toBeNull()
  })

  it("supports sha-512", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth({ algorithm: "sha-512" })] })
    await m.post("https://x.test/", RFC9530_BODY)
    const v = captured?.get("content-digest")
    expect(v).toMatch(/^sha-512=:[A-Za-z0-9+/=]+:$/)
  })

  it("skips empty bodies by default (most GETs)", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth()] })
    await m.get("https://x.test/")
    expect(captured?.get("content-digest")).toBeNull()
  })

  it("preserves the request body bytes after digesting", async () => {
    let receivedBody: string | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        receivedBody = await req.text()
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth()] })
    await m.post("https://x.test/", RFC9530_BODY, {
      headers: { "content-type": "application/json" },
    })
    expect(receivedBody).toBe(RFC9530_BODY)
  })

  it("appends to an existing Content-Digest dictionary", async () => {
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, use: [digestAuth()] })
    await m.post("https://x.test/", RFC9530_BODY, {
      headers: { "content-digest": "md5=:abc:" },
    })
    const v = captured?.get("content-digest") ?? ""
    expect(v.startsWith("md5=:abc:")).toBe(true)
    expect(v).toContain(`sha-256=:${RFC9530_SHA256}:`)
  })
})

describe("verifyDigest — incoming", () => {
  it("passes when the response Content-Digest matches", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: { "content-digest": `sha-256=:${RFC9530_SHA256}:` },
    })
    await expect(verifyDigest(res)).resolves.toBeUndefined()
  })

  it("throws DigestMismatchError when the digest is wrong", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: {
        "content-digest": "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:",
      },
    })
    await expect(verifyDigest(res)).rejects.toBeInstanceOf(DigestMismatchError)
  })

  it("returns silently when no digest header is present (RFC 9530 §1)", async () => {
    const res = new Response(RFC9530_BODY, { status: 200 })
    await expect(verifyDigest(res)).resolves.toBeUndefined()
  })

  it("ignores algorithms it doesn't understand", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: { "content-digest": "md5=:abc:" },
    })
    await expect(verifyDigest(res)).resolves.toBeUndefined()
  })

  it("verifies when at least one understood algorithm matches", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: {
        "content-digest": `md5=:abc:, sha-256=:${RFC9530_SHA256}:`,
      },
    })
    await expect(verifyDigest(res)).resolves.toBeUndefined()
  })

  it("does not consume the original response body", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: { "content-digest": `sha-256=:${RFC9530_SHA256}:` },
    })
    await verifyDigest(res)
    expect(await res.text()).toBe(RFC9530_BODY)
  })

  it("supports the Repr-Digest header field", async () => {
    const res = new Response(RFC9530_BODY, {
      status: 200,
      headers: { "repr-digest": `sha-256=:${RFC9530_SHA256}:` },
    })
    await expect(verifyDigest(res, { field: "repr-digest" })).resolves.toBeUndefined()
  })
})

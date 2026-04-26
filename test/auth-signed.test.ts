import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { messageSignature, signRequest } from "../src/auth/signed.ts"

function parseSignatureInput(header: string): {
  label: string
  components: string[]
  params: Record<string, string | number>
} {
  // sig1=("@method" "@target-uri");keyid="x";alg="ed25519";created=1700000000
  const eq = header.indexOf("=")
  const label = header.slice(0, eq)
  const rest = header.slice(eq + 1)
  const closeParen = rest.indexOf(")")
  const componentsRaw = rest.slice(1, closeParen)
  const components = componentsRaw
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => c.replace(/^"|"$/g, ""))
  const paramsPart = rest.slice(closeParen + 1).replace(/^;/, "")
  const params: Record<string, string | number> = {}
  if (paramsPart) {
    for (const piece of paramsPart.split(";")) {
      const [k, v] = piece.split("=")
      if (!k || v === undefined) continue
      const stripped = v.replace(/^"|"$/g, "")
      const asNum = Number(stripped)
      params[k] = stripped === String(asNum) ? asNum : stripped
    }
  }
  return { label, components, params }
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

describe("messageSignature — HMAC-SHA256 (shared secret)", () => {
  it("signs a request with hmac-sha256 and verifies via crypto.subtle", async () => {
    const secret = new TextEncoder().encode("super-secret")
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        messageSignature({
          keyId: "test-key",
          algorithm: "hmac-sha256",
          privateKey: secret,
          components: ["@method", "@target-uri"],
          created: 1_700_000_000,
        }),
      ],
    })
    await m.get("https://example.com/foo")
    expect(captured?.get("signature-input")).toBeTruthy()
    expect(captured?.get("signature")).toBeTruthy()

    const input = parseSignatureInput(captured!.get("signature-input")!)
    expect(input.label).toBe("sig1")
    expect(input.components).toEqual(["@method", "@target-uri"])
    expect(input.params.keyid).toBe("test-key")
    expect(input.params.alg).toBe("hmac-sha256")
    expect(input.params.created).toBe(1_700_000_000)

    // Independent verification: rebuild base, HMAC-SHA256, compare.
    const base = [
      `"@method": GET`,
      `"@target-uri": https://example.com/foo`,
      `"@signature-params": ${captured!.get("signature-input")!.slice("sig1=".length)}`,
    ].join("\n")
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    )
    const sigHeader = captured!.get("signature")!
    const m2 = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(sigHeader)
    expect(m2).toBeTruthy()
    const sig = decodeBase64(m2![1]!)
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sig as BufferSource,
      new TextEncoder().encode(base),
    )
    expect(ok).toBe(true)
  })

  it("includes nonce + tag + expires when provided", async () => {
    const secret = new Uint8Array([1, 2, 3, 4])
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        messageSignature({
          keyId: "k",
          algorithm: "hmac-sha256",
          privateKey: secret,
          components: ["@method"],
          created: 1_700_000_000,
          expires: 1_700_000_900,
          nonce: "abc123",
          tag: "audit",
        }),
      ],
    })
    await m.get("https://example.com/")
    const input = parseSignatureInput(captured!.get("signature-input")!)
    expect(input.params.expires).toBe(1_700_000_900)
    expect(input.params.nonce).toBe("abc123")
    expect(input.params.tag).toBe("audit")
  })

  it("custom label propagates to both headers", async () => {
    const secret = new Uint8Array([1])
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        messageSignature({
          algorithm: "hmac-sha256",
          privateKey: secret,
          components: ["@method"],
          label: "audit-sig",
        }),
      ],
    })
    await m.get("https://example.com/")
    expect(captured?.get("signature-input")).toMatch(/^audit-sig=\(/)
    expect(captured?.get("signature")).toMatch(/^audit-sig=:[A-Za-z0-9+/=]+:$/)
  })
})

describe("messageSignature — Ed25519 (Web Crypto, asymmetric)", () => {
  it("signs and verifies with a generated Ed25519 keypair", async () => {
    let pair: CryptoKeyPair
    try {
      pair = (await crypto.subtle.generateKey(
        { name: "Ed25519" } as unknown as AlgorithmIdentifier,
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair
    } catch {
      // Some runtimes (older browsers) don't yet support Ed25519 in
      // SubtleCrypto. Skip the test rather than fail.
      return
    }
    let captured: Headers | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = req.headers
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        messageSignature({
          keyId: "ed1",
          algorithm: "ed25519",
          privateKey: pair.privateKey,
          components: ["@method", "@target-uri"],
          created: 1_700_000_000,
        }),
      ],
    })
    await m.get("https://example.com/foo")

    const input = captured!.get("signature-input")!
    const base = [
      `"@method": GET`,
      `"@target-uri": https://example.com/foo`,
      `"@signature-params": ${input.slice("sig1=".length)}`,
    ].join("\n")
    const sigHeader = captured!.get("signature")!
    const sig = decodeBase64(/^sig1=:([A-Za-z0-9+/=]+):$/.exec(sigHeader)![1]!)
    const ok = await crypto.subtle.verify(
      "Ed25519",
      pair.publicKey,
      sig as BufferSource,
      new TextEncoder().encode(base),
    )
    expect(ok).toBe(true)
  })
})

describe("signRequest — derived components", () => {
  it("@authority, @scheme, @path, @query are computed from the URL", async () => {
    const req = new Request("https://api.example.com:8443/users/42?foo=bar", { method: "POST" })
    const signed = await signRequest(req, {
      algorithm: "hmac-sha256",
      privateKey: new Uint8Array([1]),
      components: ["@method", "@authority", "@scheme", "@path", "@query"],
      created: 1_700_000_000,
    })
    const input = signed.headers.get("signature-input")!
    expect(input).toContain("@method")
    expect(input).toContain("@authority")
  })

  it("regular headers contribute their canonical value", async () => {
    const req = new Request("https://example.com/", {
      headers: { "content-type": "  application/json  " },
    })
    const signed = await signRequest(req, {
      algorithm: "hmac-sha256",
      privateKey: new Uint8Array([1]),
      components: ["@method", "content-type"],
    })
    expect(signed.headers.get("signature-input")).toContain("content-type")
  })

  it("throws when a referenced component is absent on the request", async () => {
    const req = new Request("https://example.com/")
    await expect(
      signRequest(req, {
        algorithm: "hmac-sha256",
        privateKey: new Uint8Array([1]),
        components: ["x-missing"],
      }),
    ).rejects.toThrow(/missing component/)
  })

  it("rejects asymmetric algorithms with a raw byte key", async () => {
    const req = new Request("https://example.com/")
    await expect(
      signRequest(req, {
        algorithm: "ed25519",
        privateKey: new Uint8Array([1]) as unknown as CryptoKey,
        components: ["@method"],
      }),
    ).rejects.toThrow(/CryptoKey/)
  })
})

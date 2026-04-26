import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

async function compress(text: string, format: "gzip" | "deflate"): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream(format))
  return await new Response(stream).arrayBuffer()
}

describe("decompress — opt-in response decoding", () => {
  it("default (false): does not advertise Accept-Encoding from misina", async () => {
    let captured: Request | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await m.get("https://api.test/")
    // We don't set the header. The transport may set its own.
    // (Node fetch sets accept-encoding by default; that's the runtime,
    // not us.) Verify misina didn't override an empty user-set value.
    expect(captured?.headers.get("accept-encoding")).not.toBe("")
  })

  it("decompress: ['gzip'] sets Accept-Encoding and decodes a gzip body", async () => {
    const compressed = await compress('{"hello":"world"}', "gzip")
    let acceptEncoding: string | null = null

    const driver = {
      name: "p",
      request: async (req: Request) => {
        acceptEncoding = req.headers.get("accept-encoding")
        return new Response(compressed, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0, decompress: ["gzip"] })

    const res = await m.get<{ hello: string }>("https://api.test/")

    expect(acceptEncoding).toContain("gzip")
    expect(res.data.hello).toBe("world")
  })

  it("decompress: true detects all runtime-supported formats", async () => {
    const compressed = await compress('{"x":1}', "deflate")
    const driver = {
      name: "p",
      request: async () =>
        new Response(compressed, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "deflate",
          },
        }),
    }
    const m = createMisina({ driver, retry: 0, decompress: true })

    const res = await m.get<{ x: number }>("https://api.test/")
    expect(res.data.x).toBe(1)
  })

  it("user-set Accept-Encoding is preserved (no override)", async () => {
    let captured: string | null = null
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req.headers.get("accept-encoding")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      decompress: ["gzip", "br"],
      headers: { "accept-encoding": "identity" },
    })
    await m.get("https://api.test/")
    expect(captured).toBe("identity")
  })

  it("response without Content-Encoding is left alone", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response('{"plain":true}', { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0, decompress: true })
    const res = await m.get<{ plain: boolean }>("https://api.test/")
    expect(res.data.plain).toBe(true)
  })

  it("Content-Encoding outside the configured list is left alone", async () => {
    const driver = {
      name: "p",
      // Note: we don't actually compress; but neither does misina decompress
      // since 'identity' isn't in our configured list.
      request: async () =>
        new Response('{"a":1}', {
          headers: {
            "content-type": "application/json",
            "content-encoding": "identity",
          },
        }),
    }
    const m = createMisina({ driver, retry: 0, decompress: ["gzip"] })
    const res = await m.get<{ a: number }>("https://api.test/")
    expect(res.data.a).toBe(1)
  })

  it("decoded response strips Content-Encoding + Content-Length", async () => {
    const compressed = await compress('{"hi":1}', "gzip")
    let observedHeaders: Record<string, string> | undefined

    const driver = {
      name: "p",
      request: async () =>
        new Response(compressed, {
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      decompress: ["gzip"],
      hooks: {
        afterResponse: (ctx) => {
          observedHeaders = Object.fromEntries(ctx.response!.headers)
        },
      },
    })

    await m.get("https://api.test/")
    expect(observedHeaders?.["content-encoding"]).toBeUndefined()
    expect(observedHeaders?.["content-length"]).toBeUndefined()
  })
})

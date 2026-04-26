import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function decodeGzip(bytes: Uint8Array): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
  const transform = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  const decoded = stream.pipeThrough(transform)
  const result = await readStream(decoded)
  return new TextDecoder().decode(result)
}

describe("compressRequestBody", () => {
  it("compresses a JSON body and sets Content-Encoding: gzip", async () => {
    let captured: { headers: Headers; bytes: Uint8Array } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        const bytes = new Uint8Array(await req.arrayBuffer())
        captured = { headers: req.headers, bytes }
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, compressRequestBody: "gzip" })
    const payload = { name: "a".repeat(500) }
    await m.post("https://x.test/", payload)
    expect(captured?.headers.get("content-encoding")).toBe("gzip")
    // Compressed bytes should be much smaller than the raw JSON.
    const raw = JSON.stringify(payload)
    expect(captured!.bytes.byteLength).toBeLessThan(raw.length)
    // Round-trip: gunzip should recover the original JSON.
    const decoded = await decodeGzip(captured!.bytes)
    expect(decoded).toBe(raw)
  })

  it("compresses string bodies", async () => {
    let captured: { headers: Headers; bytes: Uint8Array } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        const bytes = new Uint8Array(await req.arrayBuffer())
        captured = { headers: req.headers, bytes }
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, compressRequestBody: true })
    await m.post("https://x.test/", "x".repeat(1000), {
      headers: { "content-type": "text/plain" },
    })
    expect(captured?.headers.get("content-encoding")).toBeTruthy()
    expect(captured!.bytes.byteLength).toBeLessThan(1000)
  })

  it("skips FormData bodies (multipart boundary contract)", async () => {
    let captured: { headers: Headers } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = { headers: req.headers }
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, compressRequestBody: "gzip" })
    const fd = new FormData()
    fd.set("a", "1")
    await m.post("https://x.test/", fd)
    // No Content-Encoding because we refused to compress FormData.
    expect(captured?.headers.get("content-encoding")).toBeNull()
  })

  it("skips when compressRequestBody is false (default)", async () => {
    let captured: { headers: Headers } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = { headers: req.headers }
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await m.post("https://x.test/", { a: 1 })
    expect(captured?.headers.get("content-encoding")).toBeNull()
  })

  it("removes any caller-supplied Content-Length after compression", async () => {
    let captured: { headers: Headers } | undefined
    const driver = {
      name: "x",
      request: async (req: Request) => {
        captured = { headers: req.headers }
        return new Response("ok", { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0, compressRequestBody: "gzip" })
    await m.post("https://x.test/", "x".repeat(200), {
      headers: { "content-type": "text/plain", "content-length": "200" },
    })
    expect(captured?.headers.get("content-length")).toBeNull()
  })
})

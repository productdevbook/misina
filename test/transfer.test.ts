import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { downloadResumable, uploadResumable } from "../src/transfer/index.ts"

function makeBytes(n: number, fill = 0): Uint8Array {
  const out = new Uint8Array(n)
  out.fill(fill)
  return out
}

describe("downloadResumable", () => {
  it("issues Range requests when the server advertises bytes ranges", async () => {
    const total = 1000
    const full = makeBytes(total, 7)
    const requests: Array<{ method: string; range: string | null }> = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        requests.push({ method: req.method, range: req.headers.get("range") })
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: {
              "accept-ranges": "bytes",
              "content-length": String(total),
            },
          })
        }
        const range = req.headers.get("range")
        if (!range) return new Response(full as BodyInit, { status: 200 })
        const m = /bytes=(\d+)-(\d+)/.exec(range)
        if (!m) return new Response(full as BodyInit, { status: 200 })
        const start = Number(m[1])
        const end = Number(m[2])
        return new Response(full.slice(start, end + 1) as BodyInit, {
          status: 206,
          headers: {
            "content-range": `bytes ${start}-${end}/${total}`,
            "content-length": String(end - start + 1),
          },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const progressEvents: number[] = []
    const result = await downloadResumable(m, "https://x.test/file", {
      chunkSize: 256,
      onProgress: ({ loaded }) => progressEvents.push(loaded),
    })
    expect(result.ranged).toBe(true)
    expect(result.size).toBe(total)
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(bytes.byteLength).toBe(total)
    expect(bytes.every((b) => b === 7)).toBe(true)
    // 1000 / 256 = 4 chunks.
    const rangedReqs = requests.filter((r) => r.method === "GET" && r.range !== null)
    expect(rangedReqs).toHaveLength(4)
    // Progress was reported across chunks.
    expect(progressEvents.length).toBeGreaterThanOrEqual(4)
  })

  it("falls back to a streaming GET when ranges aren't advertised", async () => {
    const total = 200
    const full = makeBytes(total, 3)
    let getCount = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          // No accept-ranges advertisement.
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(total) },
          })
        }
        getCount++
        return new Response(full as BodyInit, { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file", { chunkSize: 50 })
    expect(result.ranged).toBe(false)
    expect(result.size).toBe(total)
    expect(getCount).toBe(1)
  })

  it("retries a failing chunk up to maxRetries", async () => {
    const total = 100
    const full = makeBytes(total, 1)
    const attempts: Record<string, number> = {}
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": String(total) },
          })
        }
        const range = req.headers.get("range") ?? "all"
        attempts[range] = (attempts[range] ?? 0) + 1
        // Fail the second chunk's first attempt; succeed thereafter.
        if (range === "bytes=50-99" && attempts[range] === 1) {
          throw new TypeError("net fail")
        }
        const m = /bytes=(\d+)-(\d+)/.exec(range)
        if (!m) return new Response(full as BodyInit, { status: 200 })
        const start = Number(m[1])
        const end = Number(m[2])
        return new Response(full.slice(start, end + 1) as BodyInit, { status: 206 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file", { chunkSize: 50 })
    expect(result.size).toBe(total)
    expect(attempts["bytes=50-99"]).toBe(2)
  })
})

describe("uploadResumable", () => {
  it("opens with POST + Location, then PATCHes chunks with Upload-Offset", async () => {
    const total = 1000
    const source = makeBytes(total, 9)
    const events: Array<{ method: string; offset: string | null; incomplete: string | null }> = []
    const stored: number[] = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        events.push({
          method: req.method,
          offset: req.headers.get("upload-offset"),
          incomplete: req.headers.get("upload-incomplete"),
        })
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/abc" },
          })
        }
        if (req.method === "PATCH") {
          const buf = new Uint8Array(await req.arrayBuffer())
          stored.push(buf.byteLength)
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const progress: number[] = []
    const result = await uploadResumable(m, "https://x.test/uploads", source, {
      chunkSize: 300,
      onProgress: ({ loaded }) => progress.push(loaded),
    })
    expect(result.uploadUrl).toBe("https://x.test/uploads/abc")
    expect(result.uploaded).toBe(total)
    // 1000/300 = 4 PATCHes (300, 300, 300, 100).
    const patches = events.filter((e) => e.method === "PATCH")
    expect(patches).toHaveLength(4)
    expect(stored).toEqual([300, 300, 300, 100])
    // First three carry Upload-Incomplete: ?1; last carries ?0.
    expect(patches.slice(0, 3).every((p) => p.incomplete === "?1")).toBe(true)
    expect(patches[3]?.incomplete).toBe("?0")
    // Offsets are monotonically increasing.
    expect(patches.map((p) => Number(p.offset))).toEqual([0, 300, 600, 900])
  })

  it("resumes from server-known offset when uploadUrl is provided", async () => {
    const total = 500
    const source = makeBytes(total, 4)
    const events: Array<{ method: string; offset: string | null }> = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        events.push({ method: req.method, offset: req.headers.get("upload-offset") })
        if (req.method === "HEAD") {
          // Server already has 200 bytes.
          return new Response(null, {
            status: 200,
            headers: { "upload-offset": "200" },
          })
        }
        if (req.method === "PATCH") {
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await uploadResumable(m, "https://x.test/uploads", source, {
      chunkSize: 100,
      uploadUrl: "https://x.test/uploads/xyz",
    })
    expect(result.uploaded).toBe(total)
    // No POST issued — resumed via HEAD.
    expect(events.find((e) => e.method === "POST")).toBeUndefined()
    // First PATCH starts at offset 200, not 0.
    const firstPatch = events.find((e) => e.method === "PATCH")
    expect(firstPatch?.offset).toBe("200")
    // Three remaining PATCHes for 300 bytes at chunk=100.
    expect(events.filter((e) => e.method === "PATCH")).toHaveLength(3)
  })

  it("retries a failing PATCH up to maxRetries", async () => {
    const total = 200
    const source = makeBytes(total, 2)
    const patchAttempts: Record<string, number> = {}
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/k" },
          })
        }
        if (req.method === "PATCH") {
          const off = req.headers.get("upload-offset") ?? ""
          patchAttempts[off] = (patchAttempts[off] ?? 0) + 1
          if (off === "100" && patchAttempts[off] === 1) {
            throw new TypeError("net fail")
          }
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await uploadResumable(m, "https://x.test/uploads", source, { chunkSize: 100 })
    expect(patchAttempts["0"]).toBe(1)
    expect(patchAttempts["100"]).toBe(2)
  })
})

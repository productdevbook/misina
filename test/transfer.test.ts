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

describe("downloadResumable — fallback / probe paths", () => {
  it("falls back to a Range probe when HEAD is rejected and uses Content-Range total", async () => {
    const total = 600
    const full = makeBytes(total, 5)
    const requests: Array<{ method: string; range: string | null }> = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        requests.push({ method: req.method, range: req.headers.get("range") })
        if (req.method === "HEAD") {
          throw new TypeError("HEAD not allowed")
        }
        const range = req.headers.get("range")
        if (range === "bytes=0-0") {
          return new Response(full.slice(0, 1) as BodyInit, {
            status: 206,
            headers: {
              "content-range": `bytes 0-0/${total}`,
              "content-length": "1",
            },
          })
        }
        const m = /bytes=(\d+)-(\d+)/.exec(range ?? "")
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
    const result = await downloadResumable(m, "https://x.test/file", { chunkSize: 200 })
    expect(result.ranged).toBe(true)
    expect(result.size).toBe(total)
    // At least one HEAD attempt + the bytes=0-0 probe + chunk fetches.
    expect(requests.find((r) => r.range === "bytes=0-0")).toBeDefined()
  })

  it("falls back to a streaming GET when HEAD throws and the Range probe also throws", async () => {
    const total = 80
    const full = makeBytes(total, 6)
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") throw new TypeError("HEAD blocked")
        const range = req.headers.get("range")
        if (range === "bytes=0-0") throw new TypeError("Range blocked")
        return new Response(full as BodyInit, { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file")
    expect(result.ranged).toBe(false)
    expect(result.size).toBe(total)
  })

  it("falls back to streaming GET when HEAD succeeds but content-length is missing", async () => {
    const total = 50
    const full = makeBytes(total, 8)
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes" },
          })
        }
        return new Response(full as BodyInit, { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file")
    expect(result.ranged).toBe(false)
    expect(result.size).toBe(total)
  })

  it("ignores a Range probe that returns 200 (server didn't honor Range)", async () => {
    const total = 30
    const full = makeBytes(total, 9)
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") throw new TypeError("HEAD blocked")
        return new Response(full as BodyInit, { status: 200 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file")
    expect(result.ranged).toBe(false)
    expect(result.size).toBe(total)
  })

  it("handles a streaming GET response with no body (reader is undefined)", async () => {
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          return new Response(null, { status: 200 })
        }
        return new Response(null, { status: 204 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await downloadResumable(m, "https://x.test/file")
    expect(result.ranged).toBe(false)
    expect(result.size).toBe(0)
  })
})

describe("downloadResumable — abort + retry exhaustion", () => {
  it("throws AbortError when the signal aborts before a chunk request", async () => {
    const total = 1000
    const full = makeBytes(total, 1)
    const controller = new AbortController()
    let chunksServed = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": String(total) },
          })
        }
        const range = req.headers.get("range") ?? ""
        const m = /bytes=(\d+)-(\d+)/.exec(range)
        if (!m) return new Response(full as BodyInit, { status: 200 })
        chunksServed++
        if (chunksServed === 1) controller.abort()
        const start = Number(m[1])
        const end = Number(m[2])
        return new Response(full.slice(start, end + 1) as BodyInit, { status: 206 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(
      downloadResumable(m, "https://x.test/file", {
        chunkSize: 250,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)
  })

  it("throws after exhausting maxRetries on a chunk", async () => {
    const total = 100
    let chunkAttempts = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "accept-ranges": "bytes", "content-length": String(total) },
          })
        }
        chunkAttempts++
        throw new TypeError("net fail")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(
      downloadResumable(m, "https://x.test/file", { chunkSize: 50, maxRetries: 1 }),
    ).rejects.toThrow(/Network request.*failed/)
    // maxRetries=1 → initial attempt + 1 retry = 2 calls before throw.
    expect(chunkAttempts).toBe(2)
  })
})

describe("uploadResumable — error / source / abort branches", () => {
  it("throws when the open POST returns no Location header", async () => {
    const driver = {
      name: "x",
      request: async () => new Response(null, { status: 201 }), // no location
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(uploadResumable(m, "https://x.test/uploads", makeBytes(10, 1))).rejects.toThrow(
      /did not return Location/,
    )
  })

  it("starts from offset 0 when resume HEAD fails", async () => {
    const total = 200
    const source = makeBytes(total, 3)
    const events: Array<{ method: string; offset: string | null }> = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        events.push({ method: req.method, offset: req.headers.get("upload-offset") })
        if (req.method === "HEAD") throw new TypeError("HEAD blocked")
        if (req.method === "PATCH") return new Response(null, { status: 204 })
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await uploadResumable(m, "https://x.test/uploads", source, {
      chunkSize: 100,
      uploadUrl: "https://x.test/uploads/q",
    })
    expect(result.uploaded).toBe(total)
    const firstPatch = events.find((e) => e.method === "PATCH")
    expect(firstPatch?.offset).toBe("0")
  })

  it("resume: starts from 0 when HEAD succeeds but has no upload-offset header", async () => {
    const total = 100
    const source = makeBytes(total, 4)
    const events: Array<{ method: string; offset: string | null }> = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        events.push({ method: req.method, offset: req.headers.get("upload-offset") })
        if (req.method === "HEAD") return new Response(null, { status: 200 })
        if (req.method === "PATCH") return new Response(null, { status: 204 })
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await uploadResumable(m, "https://x.test/uploads", source, {
      chunkSize: 50,
      uploadUrl: "https://x.test/uploads/r",
    })
    expect(result.uploaded).toBe(total)
    const firstPatch = events.find((e) => e.method === "PATCH")
    expect(firstPatch?.offset).toBe("0")
  })

  describe.each([
    {
      kind: "Blob",
      make: (n: number): Blob => new Blob([makeBytes(n, 1) as BlobPart]),
      total: 250,
      chunk: 100,
      expected: [100, 100, 50],
    },
    {
      kind: "ArrayBuffer",
      make: (n: number): ArrayBuffer => {
        const b = new ArrayBuffer(n)
        new Uint8Array(b).fill(2)
        return b
      },
      total: 180,
      chunk: 80,
      expected: [80, 80, 20],
    },
    {
      kind: "Uint8Array",
      make: (n: number): Uint8Array => makeBytes(n, 3),
      total: 120,
      chunk: 50,
      expected: [50, 50, 20],
    },
  ])("slices a $kind source across PATCHes", ({ make, total, chunk, expected }) => {
    it("uploads in expected chunk sizes", async () => {
      const stored: number[] = []
      const driver = {
        name: "x",
        request: async (req: Request) => {
          if (req.method === "POST") {
            return new Response(null, {
              status: 201,
              headers: { location: "https://x.test/uploads/src" },
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
      const result = await uploadResumable(m, "https://x.test/uploads", make(total), {
        chunkSize: chunk,
      })
      expect(result.uploaded).toBe(total)
      expect(stored).toEqual(expected)
    })
  })

  it("resolves Location relative to the POST URL", async () => {
    const total = 50
    const source = makeBytes(total, 5)
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "/uploads/relative-id" },
          })
        }
        if (req.method === "PATCH") return new Response(null, { status: 204 })
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await uploadResumable(m, "https://x.test/uploads/init", source, {
      chunkSize: 50,
    })
    expect(result.uploadUrl).toBe("https://x.test/uploads/relative-id")
  })

  it("throws AbortError when the signal aborts mid-upload", async () => {
    const total = 400
    const source = makeBytes(total, 6)
    const controller = new AbortController()
    let patches = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/abrt" },
          })
        }
        if (req.method === "PATCH") {
          patches++
          if (patches === 1) controller.abort()
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(
      uploadResumable(m, "https://x.test/uploads", source, {
        chunkSize: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)
    expect(patches).toBe(1)
  })

  it("throws after exhausting maxRetries on a PATCH", async () => {
    const total = 80
    const source = makeBytes(total, 7)
    let patchAttempts = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/dead" },
          })
        }
        if (req.method === "PATCH") {
          patchAttempts++
          throw new TypeError("net fail")
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(
      uploadResumable(m, "https://x.test/uploads", source, {
        chunkSize: 40,
        maxRetries: 1,
      }),
    ).rejects.toThrow(/Network request.*failed/)
    expect(patchAttempts).toBe(2)
  })

  it("aborts the inter-retry delay rather than waiting it out", async () => {
    const total = 50
    const source = makeBytes(total, 8)
    const controller = new AbortController()
    let patchCalls = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/d" },
          })
        }
        if (req.method === "PATCH") {
          patchCalls++
          // Abort during the inter-retry delay() rather than synchronously,
          // so we exercise the abort listener inside delay() (line 319).
          setTimeout(() => controller.abort(), 5)
          throw new TypeError("net fail")
        }
        return new Response(null, { status: 405 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const start = Date.now()
    await expect(
      uploadResumable(m, "https://x.test/uploads", source, {
        chunkSize: 50,
        maxRetries: 5, // 50ms * 5 = 250ms cumulative if not aborted
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    expect(patchCalls).toBeGreaterThanOrEqual(1)
  })
})

describe("uploadResumable — zero-byte source", () => {
  it("opens with POST but performs no PATCH when source is empty", async () => {
    const events: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        events.push(req.method)
        if (req.method === "POST") {
          return new Response(null, {
            status: 201,
            headers: { location: "https://x.test/uploads/empty" },
          })
        }
        return new Response(null, { status: 204 })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const progress: Array<{ loaded: number; total: number; percent: number }> = []
    const result = await uploadResumable(m, "https://x.test/uploads", new Uint8Array(0), {
      onProgress: (p) => progress.push(p),
    })
    expect(result.uploaded).toBe(0)
    expect(events).toEqual(["POST"])
    expect(progress[0]?.percent).toBe(0)
    expect(progress[0]?.loaded).toBe(0)
    expect(progress[0]?.total).toBe(0)
  })
})

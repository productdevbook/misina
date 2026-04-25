import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import type { ProgressEvent } from "../src/index.ts"

describe("progress callbacks — onDownloadProgress", () => {
  it("fires per chunk with correct loaded/total", async () => {
    const payload = new TextEncoder().encode("x".repeat(100))
    const driver = {
      name: "stream-resp",
      request: async () => {
        // Return a body in 4 chunks of 25 bytes.
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 4; i++) {
              controller.enqueue(payload.subarray(i * 25, (i + 1) * 25))
              await new Promise((r) => setTimeout(r, 1))
            }
            controller.close()
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "100",
          },
        })
      },
    }

    const events: ProgressEvent[] = []
    const m = createMisina({
      driver,
      retry: 0,
      onDownloadProgress: (e) => events.push(e),
    })

    await m.get("https://api.test/", { responseType: "arrayBuffer" })

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.loaded).toBe(100)
    expect(last?.total).toBe(100)
    expect(last?.percent).toBe(1)
  })

  it("missing content-length: total is undefined, percent is 0", async () => {
    const driver = {
      name: "no-length",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("hello"))
            controller.close()
          },
        })
        // No content-length header.
        return new Response(body, {
          headers: { "content-type": "text/plain" },
        })
      },
    }

    const events: ProgressEvent[] = []
    const m = createMisina({
      driver,
      retry: 0,
      onDownloadProgress: (e) => events.push(e),
    })

    await m.get("https://api.test/", { responseType: "text" })

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.total).toBeUndefined()
    expect(last?.percent).toBe(0)
    expect(last?.loaded).toBe(5)
  })

  it("non-numeric content-length is ignored gracefully", async () => {
    const driver = {
      name: "garbage-length",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"))
            controller.close()
          },
        })
        return new Response(body, {
          headers: { "content-type": "text/plain", "content-length": "not-a-number" },
        })
      },
    }

    const events: ProgressEvent[] = []
    const m = createMisina({
      driver,
      retry: 0,
      onDownloadProgress: (e) => events.push(e),
    })

    await m.get("https://api.test/", { responseType: "text" })
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.total).toBeUndefined()
  })
})

describe("progress callbacks — onUploadProgress", () => {
  it("fires per chunk for a string body", async () => {
    let consumedBody: Uint8Array | undefined
    const driver = {
      name: "consume-body",
      request: async (req: Request) => {
        const buf = await req.arrayBuffer()
        consumedBody = new Uint8Array(buf)
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    const events: ProgressEvent[] = []
    const m = createMisina({
      driver,
      retry: 0,
      onUploadProgress: (e) => events.push(e),
    })

    // 200 KB string → 4 chunks of 64 KB
    const payload = "a".repeat(200 * 1024)
    await m.post("https://api.test/", payload, {
      headers: { "content-type": "text/plain" },
    })

    expect(events.length).toBeGreaterThan(0)
    expect(consumedBody?.byteLength).toBe(payload.length)

    const last = events[events.length - 1]
    expect(last?.loaded).toBe(payload.length)
    expect(last?.total).toBe(payload.length)
    expect(last?.percent).toBe(1)
  })

  it("fires for ArrayBuffer body", async () => {
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }

    const events: ProgressEvent[] = []
    const m = createMisina({
      driver,
      retry: 0,
      onUploadProgress: (e) => events.push(e),
    })

    const buf = new Uint8Array(80 * 1024).fill(1).buffer
    await m.post("https://api.test/", buf, {
      headers: { "content-type": "application/octet-stream" },
    })

    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last?.loaded).toBe(80 * 1024)
  })
})

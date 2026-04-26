import { describe, expect, it } from "vitest"
import { createMisina, isResponseTooLargeError, ResponseTooLargeError } from "../src/index.ts"

describe("maxResponseSize — Content-Length fast path", () => {
  it("rejects when Content-Length exceeds limit", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("a".repeat(2000), {
          headers: { "content-type": "text/plain", "content-length": "2000" },
        }),
    }
    const m = createMisina({ driver, retry: 0, maxResponseSize: 1000 })
    await expect(m.get("https://x.test/")).rejects.toThrow(ResponseTooLargeError)
  })

  it("permits when Content-Length is under limit", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("a".repeat(500), {
          headers: { "content-type": "text/plain", "content-length": "500" },
        }),
    }
    const m = createMisina({ driver, retry: 0, maxResponseSize: 1000 })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(200)
  })

  it("ResponseTooLargeError carries limit, received, source", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("a".repeat(500), {
          headers: { "content-type": "text/plain", "content-length": "5000" },
        }),
    }
    const m = createMisina({ driver, retry: 0, maxResponseSize: 100 })
    try {
      await m.get("https://x.test/")
      expect.fail("should throw")
    } catch (err) {
      expect(isResponseTooLargeError(err)).toBe(true)
      const e = err as ResponseTooLargeError
      expect(e.limit).toBe(100)
      expect(e.received).toBe(5000)
      expect(e.source).toBe("content-length")
    }
  })
})

describe("maxResponseSize — stream byte counter", () => {
  it("aborts mid-stream when bytes exceed limit (no Content-Length)", async () => {
    // Build a streaming response without content-length so the counter path
    // is exercised.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(500)))
        controller.enqueue(new TextEncoder().encode("b".repeat(2000)))
        controller.close()
      },
    })
    const driver = {
      name: "x",
      request: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    }
    const m = createMisina({ driver, retry: 0, maxResponseSize: 1000 })
    try {
      await m.get("https://x.test/")
      expect.fail("should throw")
    } catch (err) {
      expect(isResponseTooLargeError(err)).toBe(true)
      const e = err as ResponseTooLargeError
      expect(e.source).toBe("stream")
      expect(e.received).toBeGreaterThan(1000)
    }
  })

  it("disabled by default (no cap)", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("a".repeat(10_000), {
          headers: { "content-type": "text/plain" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(200)
  })

  it("explicit maxResponseSize: false disables cap", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("a".repeat(10_000), {
          headers: { "content-type": "text/plain", "content-length": "10000" },
        }),
    }
    const m = createMisina({ driver, retry: 0, maxResponseSize: false })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(200)
  })
})

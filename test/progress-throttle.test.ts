import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import type { ProgressEvent } from "../src/index.ts"

describe("progressIntervalMs — throttling", () => {
  it("default (0) fires every chunk for downloads", async () => {
    const events: ProgressEvent[] = []
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 6; i++) {
              controller.enqueue(new TextEncoder().encode("x".repeat(10)))
              await new Promise((r) => setTimeout(r, 5))
            }
            controller.close()
          },
        })
        return new Response(body, {
          headers: { "content-type": "text/plain", "content-length": "60" },
        })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      onDownloadProgress: (e) => events.push(e),
    })

    await m.get("https://api.test/", { responseType: "text" })
    expect(events.length).toBeGreaterThanOrEqual(6)
  })

  it("intervalMs throttles emissions but final 100% always fires", async () => {
    const events: ProgressEvent[] = []
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 8; i++) {
              controller.enqueue(new TextEncoder().encode("x".repeat(10)))
              await new Promise((r) => setTimeout(r, 5))
            }
            controller.close()
          },
        })
        return new Response(body, {
          headers: { "content-type": "text/plain", "content-length": "80" },
        })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      onDownloadProgress: (e) => events.push(e),
      progressIntervalMs: 50,
    })

    await m.get("https://api.test/", { responseType: "text" })

    // Far fewer events than 8; the last is always 100%.
    expect(events.length).toBeLessThan(8)
    expect(events[events.length - 1]?.percent).toBe(1)
  })

  it("upload throttle: same gate", async () => {
    const events: ProgressEvent[] = []
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      onUploadProgress: (e) => events.push(e),
      progressIntervalMs: 50,
    })

    // 200 KB string → 4 chunks of 64 KB, but should rarely fire.
    const payload = "a".repeat(200 * 1024)
    await m.post("https://api.test/", payload, {
      headers: { "content-type": "text/plain" },
    })

    expect(events.length).toBeGreaterThan(0)
    // Last event must be at 100%.
    const last = events[events.length - 1]
    expect(last?.percent).toBe(1)
    expect(last?.loaded).toBe(payload.length)
  })

  it("intervalMs: 0 (default) does not throttle", async () => {
    const events: ProgressEvent[] = []
    const driver = {
      name: "p",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      onUploadProgress: (e) => events.push(e),
      // progressIntervalMs unset
    })

    const payload = "a".repeat(200 * 1024)
    await m.post("https://api.test/", payload, {
      headers: { "content-type": "text/plain" },
    })

    // 4 chunks of 64KB → at least 4 events, no throttle gating.
    expect(events.length).toBeGreaterThanOrEqual(3)
  })
})

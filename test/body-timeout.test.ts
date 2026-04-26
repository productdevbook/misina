import { describe, expect, it } from "vitest"
import { createMisina, TimeoutError } from "../src/index.ts"

describe("bodyTimeout — cap on response-body read time", () => {
  it("default (false): no body-read cap; only the per-attempt timeout applies", async () => {
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"x":1}'))
            controller.close()
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const res = await m.get<{ x: number }>("https://api.test/")
    expect(res.data.x).toBe(1)
  })

  it("body that streams within budget reads cleanly", async () => {
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"hello":'))
            await new Promise((r) => setTimeout(r, 5))
            controller.enqueue(new TextEncoder().encode('"world"}'))
            controller.close()
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0, bodyTimeout: 100 })
    const res = await m.get<{ hello: string }>("https://api.test/")
    expect(res.data.hello).toBe("world")
  })

  it("stalled body raises TimeoutError when bodyTimeout fires", async () => {
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"start":'))
            // Never close — simulate a stalled tail.
            // The bodyTimeout will fire and abort the read.
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0, bodyTimeout: 30 })

    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(TimeoutError)
  })

  it("bodyTimeout independent of per-attempt timeout — body cap fires first", async () => {
    let firstByteAt = 0
    const driver = {
      name: "p",
      request: async () => {
        firstByteAt = Date.now()
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
            // Stall after first byte.
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      timeout: 10_000, // generous overall
      bodyTimeout: 30, // tight body cap
    })

    const start = Date.now()
    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(TimeoutError)
    const elapsed = Date.now() - start
    // body cap is 30ms; we tolerate runtime slack but it must be far under 10s.
    expect(elapsed).toBeLessThan(500)
    expect(firstByteAt).toBeGreaterThan(0)
  })

  it("per-request override beats defaults", async () => {
    const driver = {
      name: "p",
      request: async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
          },
        })
        return new Response(body, { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: 0, bodyTimeout: 5_000 })

    const start = Date.now()
    await expect(m.get("https://api.test/", { bodyTimeout: 30 })).rejects.toBeInstanceOf(
      TimeoutError,
    )
    expect(Date.now() - start).toBeLessThan(500)
  })
})

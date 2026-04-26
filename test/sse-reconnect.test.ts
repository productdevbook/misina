import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { sseStreamReconnecting } from "../src/stream/index.ts"

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

describe("sseStreamReconnecting", () => {
  it("reconnects with Last-Event-ID after EOF", async () => {
    const seenLastEventIds: Array<string | null> = []
    let call = 0
    const driver = {
      name: "x",
      request: async (req: Request) => {
        seenLastEventIds.push(req.headers.get("last-event-id"))
        call++
        if (call === 1) return sseResponse("id: 1\ndata: a\n\nid: 2\ndata: b\n\n")
        return sseResponse("id: 3\ndata: c\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const collected: string[] = []
    const events = sseStreamReconnecting(m, "https://x.test/events", {
      reconnectDelayMs: 1,
    })
    for await (const e of events) {
      collected.push(`${e.id ?? ""}:${e.data}`)
      if (collected.length === 3) break
    }

    expect(collected).toEqual(["1:a", "2:b", "3:c"])
    // First connection had no Last-Event-ID; second connection sent "2".
    expect(seenLastEventIds[0]).toBeNull()
    expect(seenLastEventIds[1]).toBe("2")
  })

  it("honors the server-sent retry: field over the fallback", async () => {
    const startTimes: number[] = []
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        startTimes.push(Date.now())
        call++
        if (call === 1) return sseResponse("retry: 50\nid: 1\ndata: a\n\n")
        return sseResponse("id: 2\ndata: b\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    let received = 0
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 5000, // would dominate the gap if used
    })
    for await (const _ of events) {
      received++
      if (received === 2) break
    }
    expect(startTimes.length).toBeGreaterThanOrEqual(2)
    const gap = startTimes[1]! - startTimes[0]!
    // Server asked for ~50ms; allow generous slack for the runtime,
    // but it must be smaller than the 5_000ms fallback.
    expect(gap).toBeLessThan(2000)
    expect(gap).toBeGreaterThanOrEqual(40)
  })

  it("stops when shouldReconnect returns false", async () => {
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        return sseResponse("id: 1\ndata: a\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    let attempts = 0
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      shouldReconnect: () => {
        attempts++
        return false
      },
    })
    let count = 0
    for await (const _ of events) count++
    expect(count).toBe(1)
    expect(call).toBe(1)
    expect(attempts).toBe(1)
  })

  it("stops when external signal aborts mid-loop", async () => {
    const controller = new AbortController()
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        return sseResponse("id: 1\ndata: a\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 50,
      signal: controller.signal,
    })
    let received = 0
    for await (const _ of events) {
      received++
      controller.abort()
    }
    expect(received).toBe(1)
  })

  it("backs off on consecutive failures and recovers on success", async () => {
    const startTimes: number[] = []
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        startTimes.push(Date.now())
        call++
        if (call >= 4) return sseResponse("id: x\ndata: ok\n\n")
        throw new TypeError("net fail")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 10,
    })
    for await (const _ of events) break
    // Three failures, fourth succeeds. Each backoff doubles.
    expect(startTimes.length).toBeGreaterThanOrEqual(4)
    const second = startTimes[2]! - startTimes[1]!
    const third = startTimes[3]! - startTimes[2]!
    // Each wait should be at least the previous wait minus jitter slack
    // (monotonic backoff under our 2^(failures-1) schedule).
    expect(third).toBeGreaterThanOrEqual(second - 5)
  })
})

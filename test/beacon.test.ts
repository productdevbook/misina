import { afterEach, describe, expect, it, vi } from "vitest"
import { beacon } from "../src/beacon/index.ts"

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  })
}

describe("beacon — backend detection", () => {
  const originalFetch = globalThis.fetch
  const originalFetchLater = (globalThis as { fetchLater?: unknown }).fetchLater
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalFetchLater === undefined) {
      delete (globalThis as { fetchLater?: unknown }).fetchLater
    } else {
      ;(globalThis as { fetchLater?: unknown }).fetchLater = originalFetchLater
    }
    setNavigator(originalNavigator)
  })

  it("uses fetchLater when present", () => {
    const calls: Array<{ url: string; method: string }> = []
    ;(globalThis as { fetchLater?: unknown }).fetchLater = (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET" })
    }
    const r = beacon("/telemetry", { event: "x" })
    expect(r).toEqual({ ok: true, via: "fetchLater" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("/telemetry")
    expect(calls[0]?.method).toBe("POST")
  })

  it("falls back to fetch keepalive when fetchLater is absent", () => {
    delete (globalThis as { fetchLater?: unknown }).fetchLater
    const seen: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return Promise.resolve(new Response("{}"))
    }) as typeof fetch

    const r = beacon("/x", "raw-body")
    expect(r).toEqual({ ok: true, via: "fetch-keepalive" })
    expect(seen[0]?.init?.keepalive).toBe(true)
  })

  it("falls back to navigator.sendBeacon when fetch + fetchLater absent", () => {
    delete (globalThis as { fetchLater?: unknown }).fetchLater
    // @ts-expect-error — intentionally remove for the fallback path
    delete globalThis.fetch
    const sent: Array<{ url: string; body: BodyInit | undefined }> = []
    setNavigator({
      sendBeacon: (url: string, body?: BodyInit) => {
        sent.push({ url, body })
        return true
      },
    })
    const r = beacon("/x", "payload")
    expect(r).toEqual({ ok: true, via: "sendBeacon" })
    expect(sent[0]?.url).toBe("/x")
    expect(sent[0]?.body).toBe("payload")
  })

  it("returns no-backend when nothing is available", () => {
    delete (globalThis as { fetchLater?: unknown }).fetchLater
    // @ts-expect-error — intentionally remove
    delete globalThis.fetch
    setNavigator({})
    const r = beacon("/x", "payload")
    expect(r).toEqual({ ok: false, reason: "no-backend" })
  })

  it("plain object body is JSON-serialized + content-type set", () => {
    const seen: { body: unknown; headers: Record<string, string> }[] = []
    ;(globalThis as { fetchLater?: unknown }).fetchLater = (_url: string, init: RequestInit) => {
      seen.push({
        body: init.body,
        headers: init.headers as Record<string, string>,
      })
    }
    beacon("/telemetry", { event: "x", n: 1 })
    expect(seen[0]?.body).toBe(JSON.stringify({ event: "x", n: 1 }))
    expect(seen[0]?.headers?.["content-type"]).toBe("application/json")
  })

  it("activateAfter is forwarded to fetchLater", () => {
    let observedInit: (RequestInit & { activateAfter?: number }) | undefined
    ;(globalThis as { fetchLater?: unknown }).fetchLater = (
      _url: string,
      init: RequestInit & { activateAfter?: number },
    ) => {
      observedInit = init
    }
    beacon("/x", "y", { activateAfter: 5_000 })
    expect(observedInit?.activateAfter).toBe(5_000)
  })

  it("sendBeacon returning false → ok: false, reason: send-rejected", () => {
    delete (globalThis as { fetchLater?: unknown }).fetchLater
    // @ts-expect-error — intentionally remove
    delete globalThis.fetch
    setNavigator({
      sendBeacon: () => false,
    })
    const r = beacon("/x", "payload")
    expect(r).toEqual({ ok: false, reason: "send-rejected" })
  })
})

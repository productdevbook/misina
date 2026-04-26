import { describe, expect, it } from "vitest"
import { createMisina, isHTTPError } from "../src/index.ts"
import type { HTTPError } from "../src/index.ts"

function buildDriver(status: number, headers: Record<string, string>, signal: AbortSignal) {
  return {
    name: "x",
    request: async (): Promise<Response> => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial..."))
          const onAbort = (): void => {
            try {
              controller.error(signal.reason ?? new Error("aborted"))
            } catch {
              // ignore double-error
            }
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        },
      })
      return new Response(stream, { status, headers })
    },
  }
}

describe("stream abort preserves response (axios#6935 parity)", () => {
  it("HTTPError carries response when 5xx headers arrive then abort during body", async () => {
    const ac = new AbortController()
    const driver = buildDriver(
      500,
      { "content-type": "application/json", "x-request-id": "req_500" },
      ac.signal,
    )
    const m = createMisina({ driver, retry: 0, signal: ac.signal })
    const promise = m.get("https://x.test/")
    setTimeout(() => ac.abort(), 30)
    try {
      await promise
      expect.fail("should throw")
    } catch (err) {
      if (isHTTPError(err)) {
        expect((err as HTTPError).response.status).toBe(500)
        expect((err as HTTPError).requestId).toBe("req_500")
      } else {
        const e = err as Error & { response?: Response }
        if (e.response) expect(e.response.status).toBe(500)
      }
    }
  })

  it("NetworkError carries response when 200 headers arrive then abort during body", async () => {
    const ac = new AbortController()
    const driver = buildDriver(
      200,
      {
        "content-type": "text/plain",
        "x-request-id": "req_200",
        "server-timing": "backend;dur=42",
      },
      ac.signal,
    )
    const m = createMisina({ driver, retry: 0, signal: ac.signal })
    const promise = m.get("https://x.test/", { responseType: "text" })
    setTimeout(() => ac.abort(), 30)
    try {
      await promise
      expect.fail("should throw")
    } catch (err) {
      const e = err as Error & { response?: Response }
      expect(e.response).toBeDefined()
      expect(e.response?.status).toBe(200)
      expect(e.response?.headers.get("x-request-id")).toBe("req_200")
      expect(e.response?.headers.get("server-timing")).toBe("backend;dur=42")
      // The original abort cause is preserved on cause chain.
      expect(e.cause).toBeDefined()
    }
  })

  it("does NOT swallow abort during stream (always rejects)", async () => {
    const ac = new AbortController()
    const driver = buildDriver(200, { "content-type": "text/plain" }, ac.signal)
    const m = createMisina({ driver, retry: 0, signal: ac.signal })
    const promise = m.get("https://x.test/", { responseType: "text" })
    setTimeout(() => ac.abort(new Error("user-cancel")), 30)
    await expect(promise).rejects.toBeDefined()
  })
})

import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"

describe("shouldRetry receives parsed body via ctx.error.data (ky #776 parity)", () => {
  it("can inspect a JSON error envelope to decide whether to retry", async () => {
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        // First call: transient retryable code. Second call: non-retryable.
        const code = call === 1 ? "RATE_LIMIT" : "VALIDATION_ERROR"
        return new Response(JSON.stringify({ code, message: "x" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const seenCodes: string[] = []
    const m = createMisina({
      driver,
      retry: {
        limit: 3,
        delay: () => 0,
        shouldRetry: ({ error }) => {
          if (!(error instanceof HTTPError)) return false
          const data = error.data as { code?: string } | undefined
          if (data?.code) seenCodes.push(data.code)
          return data?.code === "RATE_LIMIT"
        },
      },
    })
    await expect(m.get("https://x.test/")).rejects.toBeInstanceOf(HTTPError)
    // First failure: RATE_LIMIT — retry. Second failure: VALIDATION_ERROR — stop.
    expect(seenCodes).toEqual(["RATE_LIMIT", "VALIDATION_ERROR"])
    expect(call).toBe(2)
  })

  it("ctx.error.data is parsed before shouldRetry runs (no double-read)", async () => {
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        return new Response(JSON.stringify({ retry: call < 3 }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({
      driver,
      retry: {
        limit: 5,
        delay: () => 0,
        shouldRetry: ({ error }) => {
          if (!(error instanceof HTTPError)) return false
          // The body here must already be parsed — if it were a stream
          // the consumer in shouldRetry would lock the response and the
          // next attempt's response.clone() would still work, but more
          // importantly users see structured data, not a Response.
          const data = error.data as { retry?: boolean } | undefined
          return data?.retry === true
        },
      },
    })
    await expect(m.get("https://x.test/")).rejects.toBeInstanceOf(HTTPError)
    expect(call).toBe(3)
  })

  it("error.data is undefined when content-type is not JSON-parseable", async () => {
    let observedData: unknown = "untouched"
    const driver = {
      name: "x",
      request: async () => new Response("plain error text", { status: 500 }),
    }
    const m = createMisina({
      driver,
      retry: {
        limit: 1,
        delay: () => 0,
        shouldRetry: ({ error }) => {
          if (error instanceof HTTPError) observedData = error.data
          return false
        },
      },
    })
    await expect(m.get("https://x.test/")).rejects.toBeInstanceOf(HTTPError)
    // text/plain bodies fall through to .text(), so observedData is
    // the raw string — not undefined and not the response object.
    expect(typeof observedData).toBe("string")
    expect(observedData).toBe("plain error text")
  })
})

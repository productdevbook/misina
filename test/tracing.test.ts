import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { tracing } from "../src/tracing/index.ts"

function recordingDriver(): {
  name: string
  request: (req: Request) => Promise<Response>
  seen: { traceparent: string | null; tracestate: string | null; baggage: string | null }[]
} {
  const seen: {
    traceparent: string | null
    tracestate: string | null
    baggage: string | null
  }[] = []
  return {
    name: "rec",
    request: async (req) => {
      seen.push({
        traceparent: req.headers.get("traceparent"),
        tracestate: req.headers.get("tracestate"),
        baggage: req.headers.get("baggage"),
      })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
    seen,
  }
}

describe("tracing — traceparent generation", () => {
  it("auto-injects a fresh traceparent in W3C format", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing()] })
    await m.get("https://x.test/")
    const tp = driver.seen[0]?.traceparent
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })

  it("default flags is 01 (sampled)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing()] })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.traceparent?.endsWith("-01")).toBe(true)
  })

  it("custom flags are honored", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing({ flags: 0 })] })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.traceparent?.endsWith("-00")).toBe(true)
  })

  it("preserves caller-supplied traceparent (does not overwrite)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing()] })
    await m.get("https://x.test/", {
      headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
    })
    expect(driver.seen[0]?.traceparent).toBe(
      "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    )
  })

  it("each request gets a different traceparent", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing()] })
    await m.get("https://x.test/")
    await m.get("https://x.test/")
    expect(driver.seen[0]?.traceparent).not.toBe(driver.seen[1]?.traceparent)
  })
})

describe("tracing — getCurrentSpan integration", () => {
  it("uses provided span context when getCurrentSpan returns one", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      use: [
        tracing({
          getCurrentSpan: () => ({
            traceId: "0123456789abcdef0123456789abcdef",
            parentId: "fedcba9876543210",
            flags: 0x01,
            state: "vendor=value",
          }),
        }),
      ],
    })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.traceparent).toBe(
      "00-0123456789abcdef0123456789abcdef-fedcba9876543210-01",
    )
    expect(driver.seen[0]?.tracestate).toBe("vendor=value")
  })

  it("falls back to fresh traceparent when getCurrentSpan returns null", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing({ getCurrentSpan: () => null })] })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  })
})

describe("tracing — baggage", () => {
  it("adds Baggage header from static record", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      use: [tracing({ baggage: { tenant: "acme", env: "prod" } })],
    })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.baggage).toContain("tenant=acme")
    expect(driver.seen[0]?.baggage).toContain("env=prod")
  })

  it("baggage from function is evaluated per request", async () => {
    const driver = recordingDriver()
    let n = 0
    const m = createMisina({
      driver,
      retry: 0,
      use: [tracing({ baggage: () => ({ seq: String(++n) }) })],
    })
    await m.get("https://x.test/")
    await m.get("https://x.test/")
    expect(driver.seen[0]?.baggage).toBe("seq=1")
    expect(driver.seen[1]?.baggage).toBe("seq=2")
  })

  it("URL-encodes baggage keys/values", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      use: [tracing({ baggage: { "user id": "alice & bob" } })],
    })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.baggage).toBe("user%20id=alice%20%26%20bob")
  })

  it("preserves caller-supplied Baggage header", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      use: [tracing({ baggage: { tenant: "acme" } })],
    })
    await m.get("https://x.test/", { headers: { baggage: "foo=bar" } })
    expect(driver.seen[0]?.baggage).toBe("foo=bar")
  })

  it("no baggage → no header", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, use: [tracing()] })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.baggage).toBeNull()
  })
})

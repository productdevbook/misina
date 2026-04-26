import { describe, expect, it } from "vitest"
import { parseCacheStatus } from "../src/cache/index.ts"

describe("parseCacheStatus (RFC 9211)", () => {
  it("parses a single cache hit", () => {
    const out = parseCacheStatus("ExampleCache; hit; ttl=376")
    expect(out).toEqual([
      {
        cache: "ExampleCache",
        hit: true,
        ttl: 376,
        params: { hit: true, ttl: 376 },
      },
    ])
  })

  it("parses a chain of caches in order (first = nearest origin)", () => {
    const out = parseCacheStatus(
      'OriginCache; hit; ttl=86400, "CDN"; hit; ttl=120, BrowserCache; fwd=miss',
    )
    expect(out).toHaveLength(3)
    expect(out[0]?.cache).toBe("OriginCache")
    expect(out[0]?.hit).toBe(true)
    expect(out[1]?.cache).toBe("CDN")
    expect(out[1]?.ttl).toBe(120)
    expect(out[2]?.cache).toBe("BrowserCache")
    expect(out[2]?.fwd).toBe("miss")
  })

  it("parses fwd=stale with fwd-status=200", () => {
    const out = parseCacheStatus("ExampleCache; fwd=stale; fwd-status=200; stored")
    expect(out[0]?.fwd).toBe("stale")
    expect(out[0]?.fwdStatus).toBe(200)
    expect(out[0]?.stored).toBe(true)
  })

  it("parses collapsed and key params", () => {
    const out = parseCacheStatus('ExampleCache; hit; collapsed; key="GET /a?b=1"')
    expect(out[0]?.collapsed).toBe(true)
    expect(out[0]?.key).toBe("GET /a?b=1")
  })

  it("preserves unknown params in entry.params", () => {
    const out = parseCacheStatus('ExampleCache; hit; ttl=10; vendor="acme"; experiment=42')
    expect(out[0]?.params.vendor).toBe("acme")
    expect(out[0]?.params.experiment).toBe(42)
  })

  it("returns empty array for null/empty input", () => {
    expect(parseCacheStatus(null)).toEqual([])
    expect(parseCacheStatus("")).toEqual([])
    expect(parseCacheStatus(undefined)).toEqual([])
  })

  it("returns empty array on parse failure", () => {
    expect(parseCacheStatus("@@@invalid")).toEqual([])
  })

  it("handles quoted-string cache identifier (RFC 9211 §2 example)", () => {
    const out = parseCacheStatus('"My Cache"; hit')
    expect(out[0]?.cache).toBe("My Cache")
    expect(out[0]?.hit).toBe(true)
  })
})

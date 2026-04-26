import { describe, expect, it } from "vitest"
import { parseRateLimitHeaders } from "../src/ratelimit/index.ts"

function h(record: Record<string, string>): Headers {
  return new Headers(record)
}

describe("parseRateLimitHeaders — OpenAI style", () => {
  it("parses x-ratelimit-*-requests + -tokens together", () => {
    const result = parseRateLimitHeaders(
      h({
        "x-ratelimit-limit-requests": "500",
        "x-ratelimit-remaining-requests": "498",
        "x-ratelimit-reset-requests": "30s",
        "x-ratelimit-limit-tokens": "100000",
        "x-ratelimit-remaining-tokens": "85000",
        "x-ratelimit-reset-tokens": "1m20s",
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.requests?.limit).toBe(500)
    expect(result!.requests?.remaining).toBe(498)
    expect(result!.requests?.resetAt).toBeInstanceOf(Date)
    expect(result!.tokens?.limit).toBe(100_000)
    expect(result!.tokens?.remaining).toBe(85_000)
  })

  it("only one bucket present", () => {
    const result = parseRateLimitHeaders(
      h({
        "x-ratelimit-limit-requests": "60",
        "x-ratelimit-remaining-requests": "59",
      }),
    )
    expect(result?.requests?.limit).toBe(60)
    expect(result?.tokens).toBeUndefined()
  })
})

describe("parseRateLimitHeaders — IETF draft (RateLimit-*)", () => {
  it("parses bare RateLimit-Limit / -Remaining / -Reset", () => {
    const result = parseRateLimitHeaders(
      h({
        "ratelimit-limit": "100",
        "ratelimit-remaining": "95",
        "ratelimit-reset": "60",
      }),
    )
    expect(result?.requests?.limit).toBe(100)
    expect(result?.requests?.remaining).toBe(95)
    expect(result?.requests?.resetAt).toBeInstanceOf(Date)
    expect(result?.tokens).toBeUndefined()
  })
})

describe("parseRateLimitHeaders — reset value formats", () => {
  it("treats small integer as seconds-from-now", () => {
    const before = Date.now()
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "30", "x-ratelimit-limit-requests": "1" }),
    )
    const reset = result!.requests!.resetAt!
    expect(reset.getTime()).toBeGreaterThanOrEqual(before + 29_900)
    expect(reset.getTime()).toBeLessThanOrEqual(before + 30_500)
  })

  it("treats large integer as absolute Unix seconds", () => {
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "1745680800", "x-ratelimit-limit-requests": "1" }),
    )
    const reset = result!.requests!.resetAt!
    expect(reset.getTime()).toBe(1745680800 * 1000)
  })

  it("parses ISO 8601 reset", () => {
    const result = parseRateLimitHeaders(
      h({
        "x-ratelimit-reset-requests": "2026-04-26T15:00:00Z",
        "x-ratelimit-limit-requests": "1",
      }),
    )
    expect(result!.requests!.resetAt!.toISOString()).toBe("2026-04-26T15:00:00.000Z")
  })

  it("parses duration suffix '500ms'", () => {
    const before = Date.now()
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "500ms", "x-ratelimit-limit-requests": "1" }),
    )
    const reset = result!.requests!.resetAt!
    expect(reset.getTime() - before).toBeGreaterThanOrEqual(490)
    expect(reset.getTime() - before).toBeLessThanOrEqual(550)
  })

  it("parses duration suffix '1m30s'", () => {
    const before = Date.now()
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "1m30s", "x-ratelimit-limit-requests": "1" }),
    )
    const reset = result!.requests!.resetAt!
    expect(reset.getTime() - before).toBeGreaterThanOrEqual(89_900)
    expect(reset.getTime() - before).toBeLessThanOrEqual(90_500)
  })

  it("parses duration suffix '2h15m'", () => {
    const before = Date.now()
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "2h15m", "x-ratelimit-limit-requests": "1" }),
    )
    const reset = result!.requests!.resetAt!
    expect(reset.getTime() - before).toBeGreaterThanOrEqual(2 * 3600 * 1000 + 15 * 60 * 1000 - 100)
  })

  it("malformed reset value yields undefined", () => {
    const result = parseRateLimitHeaders(
      h({ "x-ratelimit-reset-requests": "tomorrow", "x-ratelimit-limit-requests": "1" }),
    )
    expect(result?.requests?.resetAt).toBeUndefined()
  })
})

describe("parseRateLimitHeaders — edge cases", () => {
  it("returns null when no recognized headers present", () => {
    const result = parseRateLimitHeaders(h({ "content-type": "application/json" }))
    expect(result).toBeNull()
  })

  it("returns bucket even if only limit is present", () => {
    const result = parseRateLimitHeaders(h({ "ratelimit-limit": "100" }))
    expect(result?.requests?.limit).toBe(100)
    expect(result?.requests?.remaining).toBeUndefined()
    expect(result?.requests?.resetAt).toBeUndefined()
  })

  it("OpenAI style takes precedence over generic when both present", () => {
    const result = parseRateLimitHeaders(
      h({
        "x-ratelimit-limit-requests": "500",
        "ratelimit-limit": "100", // ignored — OpenAI style won
      }),
    )
    expect(result?.requests?.limit).toBe(500)
  })

  it("ignores non-numeric limit/remaining", () => {
    const result = parseRateLimitHeaders(
      h({
        "x-ratelimit-limit-requests": "many",
        "x-ratelimit-remaining-requests": "59",
      }),
    )
    expect(result?.requests?.limit).toBeUndefined()
    expect(result?.requests?.remaining).toBe(59)
  })
})

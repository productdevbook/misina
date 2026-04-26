import { describe, expect, it } from "vitest"
import { isJsonContentType, isProblemJsonContentType } from "../src/_content_type.ts"
import { createMisina } from "../src/index.ts"

describe("RFC 6839 +json suffix detection", () => {
  it("matches application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true)
  })
  it("matches application/json with charset", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true)
  })
  it("matches application/problem+json", () => {
    expect(isJsonContentType("application/problem+json")).toBe(true)
  })
  it("matches application/ld+json (linked data)", () => {
    expect(isJsonContentType("application/ld+json")).toBe(true)
  })
  it("matches vendor +json (Contentful)", () => {
    expect(isJsonContentType("application/vnd.contentful.management.v1+json")).toBe(true)
  })
  it("matches uppercase", () => {
    expect(isJsonContentType("APPLICATION/JSON")).toBe(true)
    expect(isJsonContentType("Application/Vnd.X+JSON")).toBe(true)
  })
  it("does NOT match text/json (per RFC 8259)", () => {
    expect(isJsonContentType("text/json")).toBe(false)
  })
  it("does NOT match application/json5", () => {
    expect(isJsonContentType("application/json5")).toBe(false)
  })
  it("does NOT match arbitrary text", () => {
    expect(isJsonContentType("text/plain")).toBe(false)
    expect(isJsonContentType("application/octet-stream")).toBe(false)
  })
  it("returns false for null/undefined/empty", () => {
    expect(isJsonContentType(null)).toBe(false)
    expect(isJsonContentType(undefined)).toBe(false)
    expect(isJsonContentType("")).toBe(false)
  })
})

describe("RFC 9457 problem+json detection", () => {
  it("matches application/problem+json", () => {
    expect(isProblemJsonContentType("application/problem+json")).toBe(true)
  })
  it("matches with charset", () => {
    expect(isProblemJsonContentType("application/problem+json; charset=utf-8")).toBe(true)
  })
  it("does NOT match plain application/json", () => {
    expect(isProblemJsonContentType("application/json")).toBe(false)
  })
  it("does NOT match vendor +json", () => {
    expect(isProblemJsonContentType("application/vnd.contentful.management.v1+json")).toBe(false)
  })
})

describe("end-to-end: vendor +json response is parsed as JSON", () => {
  it("parses application/vnd.x+json response body", async () => {
    const driver = {
      name: "vnd",
      request: async () =>
        new Response(JSON.stringify({ ok: true, source: "vendor" }), {
          headers: { "content-type": "application/vnd.contentful.management.v1+json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get<{ ok: boolean; source: string }>("https://x.test/y")
    expect(r.data).toEqual({ ok: true, source: "vendor" })
  })

  it("parses application/ld+json response body", async () => {
    const driver = {
      name: "ld",
      request: async () =>
        new Response(JSON.stringify({ "@context": "ex", id: 42 }), {
          headers: { "content-type": "application/ld+json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get<{ "@context": string; id: number }>("https://x.test/y")
    expect(r.data["@context"]).toBe("ex")
    expect(r.data.id).toBe(42)
  })
})

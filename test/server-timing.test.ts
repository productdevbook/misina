import { describe, expect, it } from "vitest"
import { createMisina, parseServerTiming } from "../src/index.ts"

describe("parseServerTiming — direct parser", () => {
  it("parses single entry with dur and desc", () => {
    const r = parseServerTiming('cache;dur=23.2;desc="Cache Read"')
    expect(r).toEqual([{ name: "cache", dur: 23.2, desc: "Cache Read" }])
  })

  it("parses multiple entries", () => {
    const r = parseServerTiming("db;dur=53, app;dur=47.2;desc=AppLayer")
    expect(r).toEqual([
      { name: "db", dur: 53, desc: undefined },
      { name: "app", dur: 47.2, desc: "AppLayer" },
    ])
  })

  it("parses entry with name only", () => {
    const r = parseServerTiming("missedCache")
    expect(r).toEqual([{ name: "missedCache", dur: undefined, desc: undefined }])
  })

  it("respects commas inside quoted desc", () => {
    const r = parseServerTiming('a;desc="hello, world";dur=1, b;dur=2')
    expect(r).toEqual([
      { name: "a", dur: 1, desc: "hello, world" },
      { name: "b", dur: 2, desc: undefined },
    ])
  })

  it("respects semicolons inside quoted desc", () => {
    const r = parseServerTiming('a;desc="x;y";dur=1')
    expect(r).toEqual([{ name: "a", dur: 1, desc: "x;y" }])
  })

  it("returns empty array for null / undefined / empty", () => {
    expect(parseServerTiming(null)).toEqual([])
    expect(parseServerTiming(undefined)).toEqual([])
    expect(parseServerTiming("")).toEqual([])
  })

  it("ignores malformed entries silently", () => {
    const r = parseServerTiming("good;dur=1, ;;malformed, also-good;dur=2")
    expect(r.find((e) => e.name === "good")?.dur).toBe(1)
    expect(r.find((e) => e.name === "also-good")?.dur).toBe(2)
  })

  it("dur=0 is preserved (not undefined)", () => {
    const r = parseServerTiming("ok;dur=0")
    expect(r[0]?.dur).toBe(0)
  })

  it("ignores non-numeric dur", () => {
    const r = parseServerTiming("ok;dur=abc")
    expect(r[0]?.dur).toBeUndefined()
  })
})

describe("MisinaResponse.serverTimings", () => {
  it("populates from Server-Timing response header", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: {
            "content-type": "application/json",
            "server-timing": 'db;dur=53, app;dur=47.2;desc="App layer"',
          },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.serverTimings).toEqual([
      { name: "db", dur: 53, desc: undefined },
      { name: "app", dur: 47.2, desc: "App layer" },
    ])
  })

  it("empty array when header is absent", async () => {
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.serverTimings).toEqual([])
  })

  it("safe() error result.response.serverTimings is populated", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("err", {
          status: 500,
          headers: { "server-timing": "backend;dur=999" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.safe.get("https://x.test/")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response?.serverTimings).toEqual([{ name: "backend", dur: 999, desc: undefined }])
    }
  })
})

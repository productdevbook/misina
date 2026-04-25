import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import mockDriverFactory, { getMockApi } from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("appendQuery — URLSearchParams input", () => {
  it("preserves existing URL query and merges URLSearchParams", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/?a=1", {
      query: new URLSearchParams({ b: "2", c: "3" }),
    })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("a")).toBe("1")
    expect(url.searchParams.get("b")).toBe("2")
    expect(url.searchParams.get("c")).toBe("3")
  })
})

describe("appendQuery — string input", () => {
  it("string query starting with ? is accepted", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { query: "?x=1&y=2" })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("x")).toBe("1")
    expect(url.searchParams.get("y")).toBe("2")
  })

  it("string query without ? is also accepted", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { query: "x=1&y=2" })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("x")).toBe("1")
  })

  it("empty string query is a no-op", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/?keep=yes", { query: "" })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("keep")).toBe("yes")
    expect(Array.from(url.searchParams.keys())).toEqual(["keep"])
  })
})

describe("appendQuery — paramsSerializer interaction", () => {
  it("paramsSerializer is NOT applied when query is URLSearchParams (passthrough)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    let called = 0
    const m = createMisina({
      driver,
      retry: 0,
      paramsSerializer: () => {
        called++
        return "should=notbe=used"
      },
    })

    await m.get("https://api.test/", {
      query: new URLSearchParams({ a: "1" }),
    })

    expect(called).toBe(0)
    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("a")).toBe("1")
  })

  it("paramsSerializer IS applied when query is a Record", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({
      driver,
      retry: 0,
      paramsSerializer: (params) => {
        const parts = Object.entries(params).map(
          ([k, v]) => `${k}=${encodeURIComponent(String(v)).toUpperCase()}`,
        )
        return parts.join("&")
      },
    })

    await m.get("https://api.test/", { query: { greeting: "hello world" } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    // The serializer was invoked — value is uppercased.
    expect(url.searchParams.get("greeting")).toBe("HELLO WORLD")
    // Wire-level: URLSearchParams normalizes %20 → +, so check for the
    // uppercased word in either form.
    expect(getMockApi(driver)!.calls[0]!.url).toMatch(/HELLO[+%]20*WORLD|HELLO\+WORLD/)
  })
})

describe("appendQuery — preserves existing URL params", () => {
  it("merges new params alongside ones already in the URL", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/?a=1&b=2", { query: { c: 3 } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("a")).toBe("1")
    expect(url.searchParams.get("b")).toBe("2")
    expect(url.searchParams.get("c")).toBe("3")
  })

  it("query record adds duplicate keys, doesn't replace URL ones", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/?tag=a", { query: { tag: "b" } })

    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    // appendQuery uses .append, so both values are preserved (last not winning).
    expect(url.searchParams.getAll("tag")).toEqual(["a", "b"])
  })
})

describe("query — string-encoded special chars", () => {
  it("plus sign is preserved (not interpreted as space)", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({}) })
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/", { query: { q: "a+b" } })

    // URLSearchParams encodes + as %2B, so on retrieve we get a+b.
    const url = new URL(getMockApi(driver)!.calls[0]!.url)
    expect(url.searchParams.get("q")).toBe("a+b")
  })
})

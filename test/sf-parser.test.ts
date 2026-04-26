import { describe, expect, it } from "vitest"
import { parseSfDict, parseSfItem, parseSfList } from "../src/_sf.ts"

describe("RFC 9651 SF parser — items", () => {
  it("parses bare integer", () => {
    expect(parseSfItem("42")).toEqual({ value: 42, params: {} })
    expect(parseSfItem("-17")).toEqual({ value: -17, params: {} })
  })

  it("parses bare decimal", () => {
    expect(parseSfItem("3.14")).toEqual({ value: 3.14, params: {} })
    expect(parseSfItem("-0.5")).toEqual({ value: -0.5, params: {} })
  })

  it("parses string", () => {
    expect(parseSfItem('"hello"')).toEqual({ value: "hello", params: {} })
    expect(parseSfItem('"with \\"quote"')).toEqual({ value: 'with "quote', params: {} })
  })

  it("parses token", () => {
    expect(parseSfItem("foo")).toEqual({ value: { token: "foo" }, params: {} })
    expect(parseSfItem("text/plain")).toEqual({ value: { token: "text/plain" }, params: {} })
  })

  it("parses boolean", () => {
    expect(parseSfItem("?1")).toEqual({ value: true, params: {} })
    expect(parseSfItem("?0")).toEqual({ value: false, params: {} })
  })

  it("parses byte sequence", () => {
    const r = parseSfItem(":aGVsbG8=:")
    expect(r).not.toBeNull()
    expect(r!.value).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(r!.value as Uint8Array)).toBe("hello")
  })

  it("parses parameters", () => {
    expect(parseSfItem("42;foo=bar;baz")).toEqual({
      value: 42,
      params: { foo: { token: "bar" }, baz: true },
    })
  })

  it("returns null on garbage", () => {
    expect(parseSfItem("")).toBeNull()
    expect(parseSfItem("???")).toBeNull()
  })
})

describe("RFC 9651 SF parser — lists", () => {
  it("parses simple list", () => {
    const r = parseSfList("1, 2, 3")
    expect(r).toEqual([
      { value: 1, params: {} },
      { value: 2, params: {} },
      { value: 3, params: {} },
    ])
  })

  it("parses list with parameters", () => {
    const r = parseSfList("foo;a=1, bar;b=2")
    expect(r).toEqual([
      { value: { token: "foo" }, params: { a: 1 } },
      { value: { token: "bar" }, params: { b: 2 } },
    ])
  })

  it("parses inner list", () => {
    const r = parseSfList('("a" "b");q=0.5, "c"')
    expect(r).toEqual([
      {
        value: [
          { value: "a", params: {} },
          { value: "b", params: {} },
        ],
        params: { q: 0.5 },
      },
      { value: "c", params: {} },
    ])
  })

  it("returns empty array on empty input", () => {
    expect(parseSfList("")).toEqual([])
    expect(parseSfList("   ")).toEqual([])
  })

  it("returns null on garbage", () => {
    expect(parseSfList("???")).toBeNull()
  })
})

describe("RFC 9651 SF parser — dictionaries", () => {
  it("parses simple dict", () => {
    const r = parseSfDict("a=1, b=2")
    expect(r).toEqual({
      a: { value: 1, params: {} },
      b: { value: 2, params: {} },
    })
  })

  it("parses bare keys (boolean true)", () => {
    const r = parseSfDict("a, b=2, c")
    expect(r).toEqual({
      a: { value: true, params: {} },
      b: { value: 2, params: {} },
      c: { value: true, params: {} },
    })
  })

  it("parses dict with parameters", () => {
    const r = parseSfDict('hit;ttl=300, fwd="miss"')
    expect(r).toEqual({
      hit: { value: true, params: { ttl: 300 } },
      fwd: { value: "miss", params: {} },
    })
  })

  it("later duplicate key wins", () => {
    const r = parseSfDict("a=1, a=2")
    expect(r).toEqual({ a: { value: 2, params: {} } })
  })

  it("returns null on garbage", () => {
    expect(parseSfDict("?garbage")).toBeNull()
  })
})

describe("RFC 9651 SF parser — Cache-Status (RFC 9211) example", () => {
  it("parses real-world Cache-Status header", () => {
    const r = parseSfList(`ExampleCache; hit, ExampleCDN; fwd=miss; ttl=300`)
    expect(r).toEqual([
      { value: { token: "ExampleCache" }, params: { hit: true } },
      { value: { token: "ExampleCDN" }, params: { fwd: { token: "miss" }, ttl: 300 } },
    ])
  })
})

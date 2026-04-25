import { describe, expect, it } from "vitest"
import { MemoryCookieJar } from "../src/cookie/index.ts"

describe("MemoryCookieJar — RFC 6265 path matching (§5.1.4)", () => {
  it("/foo cookie not sent for /bar", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Path=/foo", "https://api.test/foo")
    expect(jar.getCookieString("https://api.test/bar")).toBe("")
  })

  it("/foo cookie IS sent for /foo/bar (subpath)", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Path=/foo", "https://api.test/foo")
    expect(jar.getCookieString("https://api.test/foo/bar")).toBe("session=abc")
  })

  it("Path defaults to / when not specified", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc", "https://api.test/users")
    expect(jar.getCookieString("https://api.test/anywhere")).toBe("session=abc")
  })
})

describe("MemoryCookieJar — RFC 6265 expiry", () => {
  it("Max-Age=0 expires the cookie immediately", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Max-Age=0", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("")
  })

  it("Max-Age in the past doesn't store the cookie", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Max-Age=-1", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("")
  })

  it("Max-Age in the future stores it", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Max-Age=3600", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("session=abc")
  })

  it("Expires past date doesn't store", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Expires=Wed, 01 Jan 1990 00:00:00 GMT", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("")
  })
})

describe("MemoryCookieJar — Secure flag", () => {
  it("Secure cookie is NOT sent over http", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Secure", "https://api.test/")
    expect(jar.getCookieString("http://api.test/")).toBe("")
  })

  it("Secure cookie IS sent over https", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Secure", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("session=abc")
  })
})

describe("MemoryCookieJar — RFC 6265 §5.3 domain check", () => {
  it("rejects Domain attribute that doesn't domain-match request host", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Domain=other.example.com", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("")
    expect(jar.getCookieString("https://other.example.com/")).toBe("")
  })

  it("accepts Domain attribute that matches a parent of the host", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Domain=example.com", "https://api.example.com/")
    // Cookie now scoped to example.com — sent to subdomains too.
    expect(jar.getCookieString("https://api.example.com/")).toBe("session=abc")
    expect(jar.getCookieString("https://other.example.com/")).toBe("session=abc")
  })

  it("strips a leading dot from Domain attribute (RFC 6265 §5.2.3)", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=abc; Domain=.example.com", "https://api.example.com/")
    expect(jar.getCookieString("https://api.example.com/")).toBe("session=abc")
  })
})

describe("MemoryCookieJar — overwrites and concurrent values", () => {
  it("setting the same name+domain+path overwrites", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("session=v1", "https://api.test/")
    jar.setCookie("session=v2", "https://api.test/")
    expect(jar.getCookieString("https://api.test/")).toBe("session=v2")
  })

  it("two cookies with different paths coexist", () => {
    const jar = new MemoryCookieJar()
    jar.setCookie("a=1; Path=/foo", "https://api.test/foo")
    jar.setCookie("a=2; Path=/bar", "https://api.test/bar")

    expect(jar.getCookieString("https://api.test/foo")).toBe("a=1")
    expect(jar.getCookieString("https://api.test/bar")).toBe("a=2")
  })
})

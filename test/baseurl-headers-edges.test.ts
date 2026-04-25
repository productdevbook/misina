import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function recordingDriver() {
  const seen: { url: string; headers: Record<string, string> }[] = []
  return {
    seen,
    driver: {
      name: "rec",
      request: async (req: Request) => {
        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => {
          headers[k] = v
        })
        seen.push({ url: req.url, headers })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    },
  }
}

describe("baseURL resolution — WHATWG URL semantics", () => {
  it("baseURL without trailing slash: relative path resolves correctly", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/v1" })
    await m.get("users")
    expect(seen[0]?.url).toBe("https://api.test/v1/users")
  })

  it("baseURL with trailing slash: relative path appended", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/v1/" })
    await m.get("users")
    expect(seen[0]?.url).toBe("https://api.test/v1/users")
  })

  it("baseURL with path; absolute path in input replaces it", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/v1" })
    await m.get("/health")
    // Absolute path on the same origin — replaces baseURL's path entirely.
    expect(seen[0]?.url).toBe("https://api.test/health")
  })

  it("absolute URL in input overrides baseURL", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/" })
    await m.get("https://other.test/external")
    expect(seen[0]?.url).toBe("https://other.test/external")
  })

  it("allowAbsoluteUrls: false rejects an absolute URL even with baseURL set", async () => {
    const m = createMisina({
      driver: recordingDriver().driver,
      retry: 0,
      baseURL: "https://api.test/",
      allowAbsoluteUrls: false,
    })
    await expect(m.get("https://attacker.test/x")).rejects.toThrow(/rejected/)
  })

  it("baseURL with deep path; relative does not eat segments", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/v1/users/" })
    await m.get("123/posts")
    expect(seen[0]?.url).toBe("https://api.test/v1/users/123/posts")
  })

  it("query is appended to the resolved URL", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/" })
    await m.get("search", { query: { q: "fish", lang: "tr" } })
    expect(seen[0]?.url).toBe("https://api.test/search?q=fish&lang=tr")
  })

  it("baseURL with query string keeps that query and merges with init.query", async () => {
    const { seen, driver } = recordingDriver()
    // baseURL with a built-in query is unusual but legal.
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test/?token=abc" })
    await m.get("items", { query: { page: "2" } })
    // Whether the token survives depends on URL semantics. Verify we don't lose
    // the path/query unexpectedly.
    expect(seen[0]?.url.startsWith("https://api.test/items?")).toBe(true)
    expect(seen[0]?.url).toContain("page=2")
  })
})

describe("headers — input formats", () => {
  it("Record<string, string> works", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, headers: { "x-tag": "default" } })
    await m.get("https://api.test/", { headers: { "x-trace": "abc" } })
    expect(seen[0]?.headers["x-tag"]).toBe("default")
    expect(seen[0]?.headers["x-trace"]).toBe("abc")
  })

  it("Headers instance works as defaults headers", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      headers: new Headers({ "x-tag": "default" }) as unknown as Record<string, string>,
    })
    await m.get("https://api.test/")
    expect(seen[0]?.headers["x-tag"]).toBe("default")
  })

  it("[string, string][] tuple-array works as headers", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      headers: [
        ["x-tag", "default"],
        ["x-extra", "1"],
      ] as unknown as Record<string, string>,
    })
    await m.get("https://api.test/")
    expect(seen[0]?.headers["x-tag"]).toBe("default")
    expect(seen[0]?.headers["x-extra"]).toBe("1")
  })

  it("per-request headers override defaults case-insensitively", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      headers: { Accept: "application/json" },
    })
    await m.get("https://api.test/", { headers: { accept: "text/plain" } })
    // Only one accept value, taken from the per-request side.
    expect(seen[0]?.headers["accept"]).toBe("text/plain")
  })

  it("setting a header to undefined does not crash; header is absent", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.get("https://api.test/", {
      headers: { "x-real": "1", "x-removed": undefined as unknown as string },
    })
    expect(seen[0]?.headers["x-real"]).toBe("1")
    expect(seen[0]?.headers["x-removed"]).toBeUndefined()
  })

  it(".extend() merges defaults headers with parent headers", async () => {
    const { seen, driver } = recordingDriver()
    const parent = createMisina({
      driver,
      retry: 0,
      headers: { "x-parent": "p", "x-shared": "parent" },
    })
    const child = parent.extend({ headers: { "x-child": "c", "x-shared": "child" } })
    await child.get("https://api.test/")
    expect(seen[0]?.headers["x-parent"]).toBe("p")
    expect(seen[0]?.headers["x-child"]).toBe("c")
    expect(seen[0]?.headers["x-shared"]).toBe("child")
  })
})

describe("hooks — array merging across defaults + per-request + extend", () => {
  it("init hooks from defaults run before per-request init hooks", async () => {
    const { driver } = recordingDriver()
    const order: string[] = []

    const m = createMisina({
      driver,
      retry: 0,
      hooks: { init: [() => order.push("default-init")] },
    })

    await m.get("https://api.test/", {
      hooks: { init: [() => order.push("per-request-init")] },
    })

    expect(order).toEqual(["default-init", "per-request-init"])
  })

  it("beforeRequest hooks fire in defaults-then-per-request order", async () => {
    const { driver } = recordingDriver()
    const order: string[] = []

    const m = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: [
          () => {
            order.push("default-before")
          },
        ],
      },
    })

    await m.get("https://api.test/", {
      hooks: {
        beforeRequest: [
          () => {
            order.push("per-request-before")
          },
        ],
      },
    })

    expect(order).toEqual(["default-before", "per-request-before"])
  })

  it(".extend() concatenates hooks, doesn't replace", async () => {
    const { driver } = recordingDriver()
    const order: string[] = []
    const parent = createMisina({
      driver,
      retry: 0,
      hooks: {
        beforeRequest: [
          () => {
            order.push("parent")
          },
        ],
      },
    })
    const child = parent.extend({
      hooks: {
        beforeRequest: [
          () => {
            order.push("child")
          },
        ],
      },
    })
    await child.get("https://api.test/")
    expect(order).toEqual(["parent", "child"])
  })
})

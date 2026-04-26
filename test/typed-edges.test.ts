import { describe, expect, it } from "vitest"
import { createMisinaTyped } from "../src/index.ts"
import mockDriverFactory from "../src/driver/mock.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("createMisinaTyped — endpoint with no required fields", () => {
  type Api = {
    "GET /health": { response: { ok: boolean } }
    "GET /users/:id": { params: { id: string }; response: { id: string } }
  }

  it("init argument is optional when there are no params / query / body", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ ok: true }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    // No second argument required.
    const res = await api.get("/health")
    expect(res.data).toEqual({ ok: true })
  })

  it("init argument is required when there are params", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ id: "42" }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const res = await api.get("/users/:id", { params: { id: "42" } })
    expect(res.data).toEqual({ id: "42" })
  })
})

describe("createMisinaTyped — path param substitution edges", () => {
  type Api = {
    "GET /users/:userId/posts/:postId": {
      params: { userId: string; postId: string }
      response: { user: string; post: string }
    }
    "GET /a/{a}/b/{b}": {
      params: { a: string; b: string }
      response: unknown
    }
  }

  it("substitutes multiple :params", async () => {
    let seen = ""
    const driver = {
      name: "watch",
      request: async (req: Request) => {
        seen = req.url
        return jsonResponse({})
      },
    }
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    await api.get("/users/:userId/posts/:postId", {
      params: { userId: "1", postId: "2" },
    })

    expect(seen).toBe("https://api.test/users/1/posts/2")
  })

  it("substitutes OpenAPI {brace} syntax", async () => {
    let seen = ""
    const driver = {
      name: "watch",
      request: async (req: Request) => {
        seen = req.url
        return jsonResponse({})
      },
    }
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    await api.get("/a/{a}/b/{b}", { params: { a: "x", b: "y" } })
    expect(seen).toBe("https://api.test/a/x/b/y")
  })

  it("URL-encodes param values", async () => {
    type Api2 = { "GET /search/:q": { params: { q: string }; response: unknown } }
    let seen = ""
    const driver = {
      name: "watch",
      request: async (req: Request) => {
        seen = req.url
        return jsonResponse({})
      },
    }
    const api = createMisinaTyped<Api2>({ driver, retry: 0, baseURL: "https://api.test" })

    await api.get("/search/:q", { params: { q: "hello world & more" } })
    expect(seen).toMatch(/hello%20world%20%26%20more/)
  })

  it("rejects '..' as a path param value (traversal)", () => {
    type Api2 = { "GET /users/:id": { params: { id: string }; response: unknown } }
    const driver = {
      name: "watch",
      request: async () => jsonResponse({}),
    }
    const api = createMisinaTyped<Api2>({ driver, retry: 0, baseURL: "https://api.test" })
    expect(() => api.get("/users/:id", { params: { id: ".." } })).toThrow(/traversal/)
  })

  it("rejects '/' separator in path param", () => {
    type Api2 = { "GET /users/:id": { params: { id: string }; response: unknown } }
    const driver = {
      name: "watch",
      request: async () => jsonResponse({}),
    }
    const api = createMisinaTyped<Api2>({ driver, retry: 0, baseURL: "https://api.test" })
    expect(() => api.get("/users/:id", { params: { id: "../admin" } })).toThrow(/separator/)
    expect(() => api.get("/users/:id", { params: { id: "a/b" } })).toThrow(/separator/)
  })

  it("rejects '\\\\' (backslash) and NUL in path param", () => {
    type Api2 = { "GET /users/:id": { params: { id: string }; response: unknown } }
    const driver = {
      name: "watch",
      request: async () => jsonResponse({}),
    }
    const api = createMisinaTyped<Api2>({ driver, retry: 0, baseURL: "https://api.test" })
    expect(() => api.get("/users/:id", { params: { id: "a\\b" } })).toThrow(/separator/)
    expect(() => api.get("/users/:id", { params: { id: "a\0b" } })).toThrow(/separator/)
  })

  it("rejects empty string and '.' segments", () => {
    type Api2 = { "GET /users/:id": { params: { id: string }; response: unknown } }
    const driver = {
      name: "watch",
      request: async () => jsonResponse({}),
    }
    const api = createMisinaTyped<Api2>({ driver, retry: 0, baseURL: "https://api.test" })
    expect(() => api.get("/users/:id", { params: { id: "" } })).toThrow(/traversal/)
    expect(() => api.get("/users/:id", { params: { id: "." } })).toThrow(/traversal/)
  })
})

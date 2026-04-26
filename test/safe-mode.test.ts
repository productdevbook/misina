import { describe, expect, it } from "vitest"
import { createMisina, HTTPError } from "../src/index.ts"

describe("misina.safe — no-throw mode", () => {
  it("ok: true on 200 with typed data", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response('{"name":"alice"}', { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.safe.get<{ name: string }>("https://api.test/users/1")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe("alice")
      expect(result.response.status).toBe(200)
      expect(result.error).toBeUndefined()
    }
  })

  it("ok: false on HTTPError; error is typed via second generic", async () => {
    interface ApiError {
      code: string
      message: string
    }
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ code: "E_FORBIDDEN", message: "nope" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.safe.get<{ name: string }, ApiError>("https://api.test/users/1")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(HTTPError)
      const httpErr = result.error as HTTPError<ApiError>
      expect(httpErr.data.code).toBe("E_FORBIDDEN")
      expect(result.response?.status).toBe(403)
    }
  })

  it("ok: false on network error; response is undefined", async () => {
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.safe.get("https://api.test/")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.name).toBe("NetworkError")
      expect(result.response).toBeUndefined()
    }
  })

  it("safe.post sends body, returns success on 201", async () => {
    let captured: Request | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req
        return new Response('{"id":"42"}', {
          status: 201,
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.safe.post<{ id: string }>("https://api.test/users", { name: "alice" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.id).toBe("42")
    }
    expect(captured?.method).toBe("POST")
    expect(await captured?.text()).toBe('{"name":"alice"}')
  })

  it("safe doesn't throw — discriminated union covers all branches", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("err", { status: 500 }),
    }
    const m = createMisina({ driver, retry: 0 })

    // Critical: this never enters a `catch` — TypeScript sees branches.
    let entered = false
    const result = await m.safe.get("https://api.test/")
    entered = true
    expect(entered).toBe(true)
    expect(result.ok).toBe(false)
  })

  it("default ok: true keeps the parsed body type", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response("[1,2,3]", { headers: { "content-type": "application/json" } }),
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await m.safe.get<number[]>("https://api.test/list")
    if (result.ok) {
      expect(result.data).toEqual([1, 2, 3])
    } else {
      throw new Error("should not be reached")
    }
  })
})

import { describe, expect, expectTypeOf, it } from "vitest"
import { createMisinaTyped } from "../src/index.ts"
import type { ResponsesOf, SuccessBodyOf, TypedSafeResult } from "../src/typed.ts"
import mockDriverFactory from "../src/driver/mock.ts"

interface User {
  id: string
  name: string
}
interface NotFound {
  message: string
}
interface RateLimited {
  retryAfter: number
}

type Api = {
  "GET /users/:id": {
    params: { id: string }
    responses: {
      200: User
      404: NotFound
      429: RateLimited
    }
  }
  "GET /health": { response: { ok: boolean } }
  "POST /users": {
    body: { name: string }
    responses: { 201: User; 422: { issues: string[] } }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createMisinaTyped — responses map", () => {
  it("response: T shorthand still resolves to 200 body for throwing methods", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ ok: true }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })
    const res = await api.get("/health")
    expect(res.data).toEqual({ ok: true })
    expectTypeOf(res.data).toEqualTypeOf<{ ok: boolean }>()
  })

  it("responses: { 200, 404, 429 } resolves throwing get to the 2xx body", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ id: "42", name: "Ada" }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })
    const res = await api.get("/users/:id", { params: { id: "42" } })
    expectTypeOf(res.data).toEqualTypeOf<User>()
    expect(res.data).toEqual({ id: "42", name: "Ada" })
  })
})

describe("createMisinaTyped — .safe namespace", () => {
  it("safe.get returns ok=true with success body on 200", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ id: "42", name: "Ada" }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.get("/users/:id", { params: { id: "42" } })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<User>()
      expect(result.data).toEqual({ id: "42", name: "Ada" })
      expect(result.status).toBe(200)
      expect(result.response).toBeInstanceOf(Response)
    }
  })

  it("safe.get returns ok=false with error.status === 404 and typed data", async () => {
    const driver = mockDriverFactory({
      response: jsonResponse({ message: "not found" }, 404),
    })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.get("/users/:id", { params: { id: "x" } })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect([404, 429]).toContain(result.error.status)
      // Discriminated narrowing on status:
      if (result.error.status === 404) {
        expectTypeOf(result.error.data).toEqualTypeOf<NotFound>()
        expect(result.error.data.message).toBe("not found")
      }
    }
  })

  it("safe.get carries 429 body shape on rate-limit", async () => {
    const driver = mockDriverFactory({
      response: jsonResponse({ retryAfter: 30 }, 429),
    })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.get("/users/:id", { params: { id: "x" } })

    expect(result.ok).toBe(false)
    if (!result.ok && result.error.status === 429) {
      expectTypeOf(result.error.data).toEqualTypeOf<RateLimited>()
      expect(result.error.data.retryAfter).toBe(30)
    }
  })

  it("safe.post returns ok=true with 201 body", async () => {
    const driver = mockDriverFactory({
      response: jsonResponse({ id: "7", name: "Lin" }, 201),
    })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.post("/users", { body: { name: "Lin" } })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<User>()
      expect(result.status).toBe(201)
    }
  })

  it("safe.post returns ok=false with 422 validation error", async () => {
    const driver = mockDriverFactory({
      response: jsonResponse({ issues: ["name too short"] }, 422),
    })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.post("/users", { body: { name: "" } })

    expect(result.ok).toBe(false)
    if (!result.ok && result.error.status === 422) {
      expectTypeOf(result.error.data).toEqualTypeOf<{ issues: string[] }>()
      expect(result.error.data.issues).toEqual(["name too short"])
    }
  })

  it("safe.get for response-shorthand endpoint still works", async () => {
    const driver = mockDriverFactory({ response: jsonResponse({ ok: true }) })
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.get("/health")

    expect(result.ok).toBe(true)
    if (result.ok) {
      expectTypeOf(result.data).toEqualTypeOf<{ ok: boolean }>()
    }
  })

  it("safe.get surfaces network errors as ok=false with status 0 instead of throwing", async () => {
    const driver = {
      name: "boom",
      request: async (): Promise<Response> => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const api = createMisinaTyped<Api>({ driver, retry: 0, baseURL: "https://api.test" })

    const result = await api.safe.get("/users/:id", { params: { id: "x" } })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.status).toBe(0)
      expect(result.response).toBeUndefined()
    }
  })
})

describe("ResponsesOf / SuccessBodyOf — type-only narrowing", () => {
  it("ResponsesOf prefers explicit responses over response shorthand", () => {
    type R1 = ResponsesOf<{ responses: { 200: User; 404: NotFound } }>
    expectTypeOf<R1>().toEqualTypeOf<{ 200: User; 404: NotFound }>()
  })

  it("ResponsesOf normalizes response: T to { 200: T }", () => {
    type R2 = ResponsesOf<{ response: User }>
    expectTypeOf<R2>().toEqualTypeOf<{ 200: User }>()
  })

  it("SuccessBodyOf unions every 2xx body", () => {
    type R = { 200: User; 201: { id: string }; 404: NotFound }
    type S = SuccessBodyOf<R>
    expectTypeOf<S>().toEqualTypeOf<User | { id: string }>()
  })

  it("TypedSafeResult is a discriminated union by ok", () => {
    type R = { 200: User; 404: NotFound }
    type T = TypedSafeResult<R>
    type Ok = Extract<T, { ok: true }>
    type Err = Extract<T, { ok: false }>
    expectTypeOf<Ok["data"]>().toEqualTypeOf<User>()
    expectTypeOf<Err["error"]>().toEqualTypeOf<{ status: 404; data: NotFound }>()
  })
})

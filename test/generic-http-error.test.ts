import { describe, expect, it } from "vitest"
import { createMisina, HTTPError, isHTTPError } from "../src/index.ts"

interface ApiError {
  code: string
  message: string
}

describe("Generic HTTPError<TBody> — typed error data", () => {
  it("default <T> generic still works (E = unknown)", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response('{"err":"bad"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get<{ ok: boolean }>("https://api.test/").catch((e) => e)) as HTTPError
    expect(err).toBeInstanceOf(HTTPError)
    // err.data is typed as unknown — assert at runtime.
    expect(err.data).toEqual({ err: "bad" })
  })

  it("explicit <T, E> generic types err.data", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ code: "E_BAD", message: "Bad request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m
      .get<{ ok: boolean }, ApiError>("https://api.test/")
      .catch((e) => e)) as HTTPError<ApiError>

    expect(isHTTPError(err)).toBe(true)
    // err.data is now ApiError at compile time AND at runtime:
    expect(err.data.code).toBe("E_BAD")
    expect(err.data.message).toBe("Bad request")
  })

  it(".onError handler receives a typed HTTPError<E>", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ code: "OFFLINE", message: "Service offline" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const recovered = await m
      .get<{ ok: boolean }, ApiError>("https://api.test/")
      .onError(503, (e) => {
        // e.data is ApiError | undefined at compile time.
        if (e instanceof HTTPError) {
          return `recovered: ${(e as HTTPError<ApiError>).data.code}`
        }
        return "recovered: ?"
      })

    expect(recovered).toBe("recovered: OFFLINE")
  })

  it("POST/PUT/PATCH/DELETE/QUERY all expose the second generic", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ code: "X", message: "x" }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m
      .post<unknown, ApiError>("https://api.test/x", { a: 1 })
      .catch((e) => e)) as HTTPError<ApiError>
    expect(err.data.code).toBe("X")
  })
})

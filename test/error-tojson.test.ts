import { describe, expect, it } from "vitest"
import { createMisina, HTTPError, MisinaError, NetworkError, TimeoutError } from "../src/index.ts"

describe("Error.toJSON() — log-library safe serialization", () => {
  it("MisinaError serializes name, message, stack, cause", () => {
    const cause = new Error("underlying")
    const err = new MisinaError("wrapped", { cause })
    const json = err.toJSON()

    expect(json.name).toBe("MisinaError")
    expect(json.message).toBe("wrapped")
    expect(typeof json.stack).toBe("string")
    expect(json.cause).toMatchObject({ name: "Error", message: "underlying" })
  })

  it("JSON.stringify(error) goes through toJSON automatically", () => {
    const err = new MisinaError("hi")
    const stringified = JSON.stringify(err)
    const parsed = JSON.parse(stringified)
    expect(parsed.name).toBe("MisinaError")
    expect(parsed.message).toBe("hi")
  })

  it("HTTPError adds status, request, response, data, problem", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ code: "BAD", reason: "x" }), {
          status: 422,
          statusText: "Unprocessable",
          headers: { "content-type": "application/json", "x-trace": "abc" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.post("https://api.test/x", { a: 1 }).catch((e) => e)) as HTTPError
    const json = err.toJSON()

    expect(json.name).toBe("HTTPError")
    expect(json.status).toBe(422)
    expect(json.statusText).toBe("Unprocessable")
    expect((json.request as { method: string }).method).toBe("POST")
    expect((json.request as { url: string }).url).toBe("https://api.test/x")
    expect((json.response as { status: number }).status).toBe(422)
    expect((json.response as { headers: Record<string, string> }).headers["x-trace"]).toBe("abc")
    expect(json.data).toEqual({ code: "BAD", reason: "x" })
  })

  it("HTTPError with problem+json includes problem field in JSON", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(
          JSON.stringify({
            type: "https://example.test/errors/over-quota",
            title: "Over Quota",
            status: 429,
            detail: "Slow down.",
          }),
          {
            status: 429,
            headers: { "content-type": "application/problem+json" },
          },
        ),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as HTTPError
    const json = err.toJSON()

    expect((json.problem as { title: string }).title).toBe("Over Quota")
  })

  it("NetworkError serializes underlying TypeError as cause", async () => {
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as NetworkError
    const json = err.toJSON()

    expect(json.name).toBe("NetworkError")
    expect((json.cause as { name: string }).name).toBe("TypeError")
    expect((json.cause as { message: string }).message).toBe("fetch failed")
  })

  it("TimeoutError serializes via toJSON", () => {
    const cause = new DOMException("Timeout of 20ms exceeded", "TimeoutError")
    const err = new TimeoutError(20, { cause })
    const json = err.toJSON()
    expect(json.name).toBe("TimeoutError")
    // MisinaError.toJSON includes name, message, stack, cause.
    expect(json).toHaveProperty("cause")
    expect((json.cause as { name: string }).name).toBe("TimeoutError")
  })
})

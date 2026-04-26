import { describe, expect, it } from "vitest"
import {
  createMisina,
  HTTPError,
  isHTTPError,
  NetworkError,
  SchemaValidationError,
  TimeoutError,
  validateSchema,
  type StandardSchemaV1,
} from "../src/index.ts"

describe("error.cause — preserved across every wrap site", () => {
  it("NetworkError carries the original TypeError as .cause", async () => {
    const original = Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
    const driver = {
      name: "broken",
      request: async () => {
        throw original
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as NetworkError
    expect(err).toBeInstanceOf(NetworkError)
    expect(err.cause).toBe(original)
  })

  it("TimeoutError carries cause when constructed with options", () => {
    const cause = new DOMException("Timeout of 20ms exceeded", "TimeoutError")
    const err = new TimeoutError(20, { cause })
    expect(err).toBeInstanceOf(TimeoutError)
    expect(err.cause).toBe(cause)
    expect((err.cause as DOMException).name).toBe("TimeoutError")
  })

  it("HTTPError captures response.url through err.response (no cause needed)", async () => {
    const driver = {
      name: "p",
      request: async () => new Response("nope", { status: 500 }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as HTTPError
    expect(isHTTPError(err)).toBe(true)
    // HTTPError doesn't need cause — it has response, request, data, status.
    // This test pins the contract: HTTPError stays cause-less by design.
    expect(err.cause).toBeUndefined()
  })

  it("SchemaValidationError exposes raw issues — sufficient diagnosis without cause", async () => {
    const schema: StandardSchemaV1<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ message: "expected number", path: ["x"] }] }),
      },
    }
    const err = (await validateSchema(schema, "x").catch((e) => e)) as SchemaValidationError
    expect(err).toBeInstanceOf(SchemaValidationError)
    expect(err.issues).toHaveLength(1)
    // SchemaValidationError doesn't wrap an underlying Error — it's the
    // underlying error itself. cause is intentionally absent.
    expect(err.cause).toBeUndefined()
  })

  it("HTTPError → user re-throw chain preserves cause", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response('{"reason":"x"}', {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    class WrappedError extends Error {
      override readonly name = "WrappedError"
    }

    let wrapped: WrappedError | undefined
    try {
      try {
        await m.get("https://api.test/")
      } catch (httpErr) {
        // User wraps with cause.
        throw new WrappedError("API failed", { cause: httpErr })
      }
    } catch (e) {
      wrapped = e as WrappedError
    }

    expect(wrapped).toBeInstanceOf(WrappedError)
    expect(wrapped?.cause).toBeInstanceOf(HTTPError)
  })

  it("MisinaError.toJSON() walks the cause chain for nested wrapping", () => {
    const innerInner = new Error("innermost")
    const inner = new NetworkError("middle", { cause: innerInner })
    const outer = new NetworkError("outermost", { cause: inner })

    const json = JSON.parse(JSON.stringify(outer))
    expect(json.cause.name).toBe("NetworkError")
    expect(json.cause.message).toBe("middle")
    // Recursive: cause.cause walks down to the plain Error.
    expect(json.cause.cause).toMatchObject({ name: "Error", message: "innermost" })
  })
})

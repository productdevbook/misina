import { describe, expect, it } from "vitest"
import { createMisina, HTTPError, type ProblemDetails } from "../src/index.ts"

describe("RFC 9457 — problem+json on HTTPError", () => {
  it("parses application/problem+json into err.problem", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(
          JSON.stringify({
            type: "https://example.test/errors/insufficient-funds",
            title: "Insufficient Funds",
            status: 402,
            detail: "Your balance is $0.00.",
            instance: "/transactions/123",
            balance: 0,
          }),
          {
            status: 402,
            headers: { "content-type": "application/problem+json" },
          },
        ),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.post("https://api.test/buy", { item: 1 }).catch((e) => e)) as HTTPError
    expect(err).toBeInstanceOf(HTTPError)
    expect(err.problem).toBeDefined()
    expect(err.problem?.type).toBe("https://example.test/errors/insufficient-funds")
    expect(err.problem?.title).toBe("Insufficient Funds")
    expect(err.problem?.status).toBe(402)
    expect(err.problem?.detail).toBe("Your balance is $0.00.")
    expect(err.problem?.instance).toBe("/transactions/123")
    // Extension fields are preserved.
    expect(err.problem?.balance).toBe(0)
  })

  it("includes problem.detail in the error message when present", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(
          JSON.stringify({
            title: "Validation Error",
            detail: "field 'email' is required",
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/problem+json" },
          },
        ),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.post("https://api.test/", { x: 1 }).catch((e) => e)) as HTTPError
    expect(err.message).toContain("400")
    expect(err.message).toContain("field 'email' is required")
  })

  it("falls back to problem.title when detail is missing", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ title: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as HTTPError
    expect(err.message).toContain("Forbidden")
  })

  it("non-problem content-type → err.problem is undefined", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ title: "Forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as HTTPError
    expect(err).toBeInstanceOf(HTTPError)
    expect(err.problem).toBeUndefined()
  })

  it("application/problem+json with charset parameter still parses", async () => {
    const driver = {
      name: "p",
      request: async () =>
        new Response(JSON.stringify({ title: "x", detail: "y" }), {
          status: 400,
          headers: { "content-type": "application/problem+json; charset=utf-8" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })

    const err = (await m.get("https://api.test/").catch((e) => e)) as HTTPError
    expect(err.problem?.title).toBe("x")
  })

  it("ProblemDetails type re-exports from the root", () => {
    // Compile-time check: the type is reachable from the root entry.
    const sample: ProblemDetails = { title: "x", status: 400 }
    expect(sample.title).toBe("x")
  })
})

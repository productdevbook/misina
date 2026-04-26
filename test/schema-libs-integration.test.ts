/**
 * Integration test against real Standard Schema implementations.
 * The inline mock test in schema-validation.test.ts pins the API
 * surface; this one verifies misina actually composes with Zod 4 and
 * Valibot 1 as published.
 *
 * Pinned versions: zod ^4 / valibot ^1. Bumping either should keep
 * these tests passing — that's their job.
 */

import { describe, expect, it } from "vitest"
import * as v from "valibot"
import { z } from "zod"
import { createMisina, isSchemaValidationError, validated, validateSchema } from "../src/index.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("Standard Schema — Zod 4 integration", () => {
  const schema = z.object({ id: z.string(), name: z.string() })

  it("validates parsed response data", async () => {
    const driver = {
      name: "x",
      request: async () => jsonResponse({ id: "42", name: "Ada" }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await validated(m.get("https://x.test/users/42"), schema)
    expect(r.data.name).toBe("Ada")
  })

  it("throws SchemaValidationError on mismatch", async () => {
    const driver = {
      name: "x",
      request: async () => jsonResponse({ id: 42, name: "Ada" }), // id wrong type
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await validated(m.get("https://x.test/users/42"), schema)
      expect.fail("should throw")
    } catch (err) {
      expect(isSchemaValidationError(err)).toBe(true)
    }
  })

  it("validateSchema standalone returns parsed value", async () => {
    const out = await validateSchema(schema, { id: "1", name: "x" })
    expect(out.id).toBe("1")
  })
})

describe("Standard Schema — Valibot 1 integration", () => {
  const schema = v.object({ id: v.string(), name: v.string() })

  it("validates parsed response data", async () => {
    const driver = {
      name: "x",
      request: async () => jsonResponse({ id: "42", name: "Ada" }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await validated(m.get("https://x.test/users/42"), schema)
    expect(r.data.name).toBe("Ada")
  })

  it("throws SchemaValidationError on mismatch", async () => {
    const driver = {
      name: "x",
      request: async () => jsonResponse({ id: 42, name: "Ada" }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await validated(m.get("https://x.test/users/42"), schema)
      expect.fail("should throw")
    } catch (err) {
      expect(isSchemaValidationError(err)).toBe(true)
    }
  })

  it("validateSchema standalone returns parsed value", async () => {
    const out = await validateSchema(schema, { id: "1", name: "x" })
    expect(out.id).toBe("1")
  })
})

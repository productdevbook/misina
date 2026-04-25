import { describe, expect, it } from "vitest"
import {
  isSchemaValidationError,
  SchemaValidationError,
  validateSchema,
  type StandardSchemaV1,
} from "../src/index.ts"

// Tiny inline standard-schema implementation so we don't depend on zod/valibot
// in the test suite. Mirrors the v1 contract.
function makeSchema<T>(
  validator: (
    value: unknown,
  ) => { value: T } | { issues: { message: string; path?: PropertyKey[] }[] },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: validator,
    },
  }
}

describe("validateSchema — happy path", () => {
  it("returns the validated value when valid", async () => {
    const schema = makeSchema<number>((v) =>
      typeof v === "number" ? { value: v } : { issues: [{ message: "expected number" }] },
    )
    const out = await validateSchema(schema, 42)
    expect(out).toBe(42)
  })

  it("supports async validator", async () => {
    const schema: StandardSchemaV1<unknown, string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (v) => {
          await new Promise((r) => setTimeout(r, 1))
          return typeof v === "string" ? { value: v } : { issues: [{ message: "expected string" }] }
        },
      },
    }
    const out = await validateSchema(schema, "hello")
    expect(out).toBe("hello")
  })
})

describe("SchemaValidationError — message formatting", () => {
  it("includes the first issue message in the default error message", async () => {
    const schema = makeSchema<number>(() => ({
      issues: [{ message: "expected number, got string" }],
    }))
    const err = (await validateSchema(schema, "oops").catch((e) => e)) as SchemaValidationError
    expect(err).toBeInstanceOf(SchemaValidationError)
    expect(err.message).toContain("expected number, got string")
  })

  it("includes the path when present", async () => {
    const schema = makeSchema<{ user: { age: number } }>(() => ({
      issues: [{ message: "expected number", path: ["user", "age"] }],
    }))
    const err = (await validateSchema(schema, { user: { age: "x" } }).catch(
      (e) => e,
    )) as SchemaValidationError
    expect(err.message).toContain("user.age")
    expect(err.message).toContain("expected number")
  })

  it("appends `+N more` when there are multiple issues", async () => {
    const schema = makeSchema<unknown>(() => ({
      issues: [
        { message: "issue 1", path: ["a"] },
        { message: "issue 2", path: ["b"] },
        { message: "issue 3", path: ["c"] },
      ],
    }))
    const err = (await validateSchema(schema, {}).catch((e) => e)) as SchemaValidationError
    expect(err.message).toContain("issue 1")
    expect(err.message).toContain("+2 more")
  })

  it("issues are reachable on the error object for full diagnostics", async () => {
    const schema = makeSchema<unknown>(() => ({
      issues: [
        { message: "name required", path: ["name"] },
        { message: "age must be ≥ 0", path: ["age"] },
      ],
    }))
    const err = (await validateSchema(schema, {}).catch((e) => e)) as SchemaValidationError
    expect(isSchemaValidationError(err)).toBe(true)
    expect(err.issues).toHaveLength(2)
    expect(err.issues[0]?.message).toBe("name required")
  })

  it("isSchemaValidationError narrows the type", async () => {
    const schema = makeSchema(() => ({ issues: [{ message: "x" }] }))
    const err = await validateSchema(schema, null).catch((e) => e)
    if (isSchemaValidationError(err)) {
      // TS knows err.issues is reachable here.
      expect(err.issues.length).toBeGreaterThan(0)
    } else {
      expect.fail("expected SchemaValidationError")
    }
  })
})

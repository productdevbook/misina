import { describe, expect, it } from "vitest"
import { path } from "../src/index.ts"

describe("path() helper", () => {
  it("substitutes :name placeholders", () => {
    expect(path("/users/:id", { id: "42" })).toBe("/users/42")
  })

  it("substitutes {name} placeholders (OpenAPI style)", () => {
    expect(path("/users/{id}/posts/{postId}", { id: "1", postId: "2" })).toBe("/users/1/posts/2")
  })

  it("URL-encodes values", () => {
    expect(path("/search/:q", { q: "hello world" })).toBe("/search/hello%20world")
  })

  it("accepts number params", () => {
    expect(path("/users/:id", { id: 42 })).toBe("/users/42")
  })

  it("rejects '..' (traversal)", () => {
    expect(() => path("/users/:id", { id: ".." })).toThrow(/traversal/)
  })

  it("rejects '/' separator in value", () => {
    expect(() => path("/users/:id", { id: "a/b" })).toThrow(/separator/)
  })

  it("rejects backslash + NUL", () => {
    expect(() => path("/users/:id", { id: "a\\b" })).toThrow(/separator/)
    expect(() => path("/users/:id", { id: "a\0b" })).toThrow(/separator/)
  })

  it("rejects CR/LF", () => {
    expect(() => path("/users/:id", { id: "a\rb" })).toThrow(/CR\/LF/)
    expect(() => path("/users/:id", { id: "a\nb" })).toThrow(/CR\/LF/)
  })

  it("throws when a required param is missing", () => {
    expect(() => path("/users/:id", {} as Parameters<typeof path<"/users/:id">>[1])).toThrow(
      /missing path param/,
    )
  })

  it("multiple params in one template", () => {
    expect(
      path("/orgs/:org/repos/:repo/pulls/:pr", {
        org: "anthropics",
        repo: "claude-code",
        pr: 42,
      }),
    ).toBe("/orgs/anthropics/repos/claude-code/pulls/42")
  })
})

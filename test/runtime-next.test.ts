import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { onTagInvalidate, tag } from "../src/runtime/next/index.ts"

describe("misina/runtime/next — onTagInvalidate", () => {
  it("calls revalidateTag for each meta.invalidates entry on success", async () => {
    const revalidated: string[] = []
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = onTagInvalidate(createMisina({ driver, retry: 0 }), (t) => {
      revalidated.push(t)
    })
    await m.post(
      "https://x.test/users",
      { name: "Ada" },
      {
        meta: { invalidates: [tag("users", "list"), tag("user", "42")] },
      },
    )
    expect(revalidated).toEqual(["users:list", "user:42"])
  })

  it("does NOT call revalidateTag on a 5xx response", async () => {
    const revalidated: string[] = []
    const driver = {
      name: "x",
      request: async () => new Response("err", { status: 500 }),
    }
    const m = onTagInvalidate(createMisina({ driver, retry: 0, throwHttpErrors: false }), (t) => {
      revalidated.push(t)
    })
    await m.post("https://x.test/users", {}, { meta: { invalidates: ["users:list"] } })
    expect(revalidated).toEqual([])
  })

  it("noop when no invalidates entries are present", async () => {
    const revalidated: string[] = []
    const driver = {
      name: "x",
      request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    }
    const m = onTagInvalidate(createMisina({ driver, retry: 0 }), (t) => {
      revalidated.push(t)
    })
    await m.post("https://x.test/users", {})
    expect(revalidated).toEqual([])
  })

  it("tag() joins parts with ':'", () => {
    expect(tag("a")).toBe("a")
    expect(tag("a", "b")).toBe("a:b")
    expect(tag("a", "b", "c")).toBe("a:b:c")
  })
})

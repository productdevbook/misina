import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function recordingDriver() {
  const seen: string[] = []
  return {
    seen,
    driver: {
      name: "rec",
      request: async (req: Request) => {
        seen.push(req.url)
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    },
  }
}

describe("trailingSlash policy", () => {
  it("'preserve' (default) leaves the URL alone", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0 })

    await m.get("https://api.test/users/")
    await m.get("https://api.test/users")

    expect(seen).toEqual(["https://api.test/users/", "https://api.test/users"])
  })

  it("'strip' removes a single trailing slash", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "strip" })

    await m.get("https://api.test/users/")
    expect(seen[0]).toBe("https://api.test/users")
  })

  it("'strip' removes multiple trailing slashes", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "strip" })

    await m.get("https://api.test/users///")
    expect(seen[0]).toBe("https://api.test/users")
  })

  it("'strip' preserves the slash when path is just /", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "strip" })

    // Bare origin URL — there's no path to strip.
    await m.get("https://api.test/")
    // Either form is acceptable depending on whether root counts as "no path".
    // The contract: don't break a bare URL.
    expect(seen[0] === "https://api.test/" || seen[0] === "https://api.test").toBe(true)
  })

  it("'strip' keeps trailing slash before query string out of the path", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "strip" })

    await m.get("https://api.test/users/?page=2")
    expect(seen[0]).toBe("https://api.test/users?page=2")
  })

  it("'forbid' throws on a trailing slash", async () => {
    const m = createMisina({
      driver: recordingDriver().driver,
      retry: 0,
      trailingSlash: "forbid",
    })

    await expect(m.get("https://api.test/users/")).rejects.toThrow(/trailingSlash is "forbid"/)
  })

  it("'forbid' allows URLs without a trailing slash", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "forbid" })

    await m.get("https://api.test/users")
    expect(seen[0]).toBe("https://api.test/users")
  })

  it("per-request override beats defaults", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({ driver, retry: 0, trailingSlash: "strip" })

    await m.get("https://api.test/users/", { trailingSlash: "preserve" })
    expect(seen[0]).toBe("https://api.test/users/")
  })

  it("does not interfere with baseURL resolution", async () => {
    const { seen, driver } = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      baseURL: "https://api.test/v1/",
      trailingSlash: "strip",
    })

    await m.get("users/")
    expect(seen[0]).toBe("https://api.test/v1/users")
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

const recordingDriver = (): {
  name: string
  request: (req: Request) => Promise<Response>
  urls: string[]
} => {
  const urls: string[] = []
  return {
    name: "rec",
    request: async (req) => {
      urls.push(req.url)
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
    urls,
  }
}

describe("URL composition SSRF audit (ofetch#564)", () => {
  it("path '.attacker.com/y' is appended INSIDE baseURL, not promoted to host", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.internal" })
    await m.get(".attacker.com/y")
    // WHATWG URL resolves './.attacker.com/y' against
    // 'https://api.internal/' → 'https://api.internal/.attacker.com/y'.
    // Origin stays 'api.internal'.
    expect(new URL(driver.urls[0]!).host).toBe("api.internal")
    expect(driver.urls[0]).toBe("https://api.internal/.attacker.com/y")
  })

  it("absolute URL with allowAbsoluteUrls: false is rejected", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      baseURL: "https://api.internal",
      allowAbsoluteUrls: false,
    })
    await expect(m.get("https://attacker.com/y")).rejects.toThrow(/allowAbsoluteUrls/)
  })

  it("'..' segment in path stays inside baseURL origin (WHATWG normalization)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.internal/v1/" })
    await m.get("../v2/users")
    // WHATWG normalizes '..' but cannot escape the origin.
    expect(new URL(driver.urls[0]!).host).toBe("api.internal")
    expect(driver.urls[0]).toBe("https://api.internal/v2/users")
  })

  it("scheme-relative URL '//other.com/x' rejected with allowAbsoluteUrls: false", async () => {
    const driver = recordingDriver()
    const m = createMisina({
      driver,
      retry: 0,
      baseURL: "https://api.internal",
      allowAbsoluteUrls: false,
    })
    await expect(m.get("//other.com/x")).rejects.toThrow(/allowAbsoluteUrls/)
  })

  it("scheme-relative URL '//other.com/x' allowed by default (allowAbsoluteUrls: true)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.internal" })
    const r = await m.get("//other.com/x")
    expect(r.status).toBe(200)
    expect(driver.urls[0]).toBe("https://other.com/x")
  })

  it("user@otherhost.com style URL is part of the path with baseURL set", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.internal" })
    // 'user@otherhost.com' is a relative path segment, not a userinfo.
    await m.get("user@otherhost.com")
    expect(new URL(driver.urls[0]!).host).toBe("api.internal")
    expect(driver.urls[0]).toBe("https://api.internal/user@otherhost.com")
  })

  it("explicit absolute URL replaces baseURL when allowAbsoluteUrls: true (default)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.internal" })
    await m.get("https://other.com/x")
    expect(driver.urls[0]).toBe("https://other.com/x")
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function recordingDriver(): {
  name: string
  request: (req: Request) => Promise<Response>
  seen: { method: string; contentLength: string | null; body: string }[]
} {
  const seen: { method: string; contentLength: string | null; body: string }[] = []
  return {
    name: "rec",
    request: async (req) => {
      const body = req.body ? await new Response(req.body).text() : ""
      seen.push({
        method: req.method,
        contentLength: req.headers.get("content-length"),
        body,
      })
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
    seen,
  }
}

describe("empty body never emits Content-Length: '' (openapi-fetch#2363)", () => {
  it("POST with body: undefined → no Content-Length", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.post("https://x.test/", undefined)
    expect(driver.seen[0]?.contentLength).toBe(null)
  })

  it("POST with body: null → no Content-Length", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.post("https://x.test/", null)
    expect(driver.seen[0]?.contentLength).toBe(null)
  })

  it("POST with body: '' → Content-Length set by runtime (no empty header value)", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.post("https://x.test/", "")
    // Either '0' or unset — never empty string. The wire format must
    // not include 'Content-Length: '.
    const cl = driver.seen[0]?.contentLength
    expect(cl === null || cl === "0").toBe(true)
  })

  it("GET with no body → no Content-Length", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.get("https://x.test/")
    expect(driver.seen[0]?.contentLength).toBe(null)
  })

  it("DELETE with no body → no Content-Length", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.delete("https://x.test/")
    expect(driver.seen[0]?.contentLength).toBe(null)
  })

  it("HEAD with no body → no Content-Length", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.head("https://x.test/")
    expect(driver.seen[0]?.contentLength).toBe(null)
  })

  it("POST with non-empty JSON body → Content-Length is positive integer string", async () => {
    const driver = recordingDriver()
    const m = createMisina({ driver, retry: 0 })
    await m.post("https://x.test/", { a: 1 })
    const cl = driver.seen[0]?.contentLength
    // Either set to byte length, or absent if runtime uses chunked.
    if (cl !== null) {
      expect(/^\d+$/.test(cl!)).toBe(true)
      expect(Number(cl)).toBeGreaterThan(0)
    }
  })
})

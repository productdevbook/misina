import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { hedge } from "../src/hedge/index.ts"

function delayedResponse(ms: number, body: unknown): (req: Request) => Promise<Response> {
  return (req) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify(body), {
              headers: { "content-type": "application/json" },
            }),
          ),
        ms,
      )
      req.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          reject(req.signal.reason)
        },
        { once: true },
      )
    })
}

describe("hedge — race across endpoints", () => {
  it("returns the data from the first endpoint to respond", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.url.startsWith("https://slow.")) {
          return delayedResponse(200, { region: "slow" })(req)
        }
        return delayedResponse(20, { region: "fast" })(req)
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ region: string }>(m, "/inference", {
      endpoints: ["https://slow.example.com", "https://fast.example.com"],
    })
    expect(data.region).toBe("fast")
  })

  it("delayMs lets the first endpoint complete before firing the second", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        return new Response(JSON.stringify({ host: new URL(req.url).host }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
      delayMs: 50,
    })
    // Primary finished synchronously (driver mock) before delayMs elapsed,
    // so the backup never fires.
    expect(data.host).toBe("primary.example.com")
    expect(seen).toEqual(["https://primary.example.com/x"])
  })

  it("falls back to the second endpoint when the first errors", async () => {
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.url.includes("primary")) return new Response("upstream down", { status: 502 })
        return new Response(JSON.stringify({ host: "backup" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const data = await hedge<{ host: string }>(m, "/x", {
      endpoints: ["https://primary.example.com", "https://backup.example.com"],
    })
    expect(data.host).toBe("backup")
  })

  it("rethrows when all endpoints fail (with cause aggregate)", async () => {
    const driver = {
      name: "x",
      request: async () => new Response("err", { status: 503 }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await hedge(m, "/x", {
        endpoints: ["https://a.test", "https://b.test"],
      })
      expect.fail("should throw")
    } catch (err) {
      // First non-loser error surfaces; AggregateError attached on cause.
      expect(err).toBeInstanceOf(Error)
      expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError)
    }
  })

  it("rejects empty endpoints array", async () => {
    const m = createMisina({ retry: 0 })
    await expect(hedge(m, "/x", { endpoints: [] })).rejects.toThrow(/empty/)
  })
})

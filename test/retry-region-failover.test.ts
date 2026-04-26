import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("retry hook can mutate request URL — region failover pattern", () => {
  it("beforeRetry returning a Request with a different host changes the next attempt's URL", async () => {
    const seen: string[] = []
    const driver = {
      name: "fail",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        // First two attempts fail with 503; the third (different region)
        // succeeds.
        if (seen.length < 3) return new Response("err", { status: 503 })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const REGIONS = [
      "https://us-east.example.com",
      "https://us-west.example.com",
      "https://eu.example.com",
    ]
    const m = createMisina({
      driver,
      retry: { limit: 2, statusCodes: [503], delay: () => 0 },
      hooks: {
        beforeRetry: ({ request, attempt }) => {
          const next = REGIONS[attempt % REGIONS.length]!
          const u = new URL(request.url)
          const target = new URL(next)
          u.host = target.host
          u.protocol = target.protocol
          return new Request(u.toString(), request)
        },
      },
    })
    const r = await m.get("https://us-east.example.com/inference")
    expect(r.status).toBe(200)
    expect(seen).toEqual([
      "https://us-east.example.com/inference",
      "https://us-west.example.com/inference",
      "https://eu.example.com/inference",
    ])
  })

  it("attempt counter increments per retry (visible to the failover hook)", async () => {
    const attempts: number[] = []
    const driver = {
      name: "x",
      request: async (): Promise<Response> => new Response("err", { status: 503 }),
    }
    const m = createMisina({
      driver,
      retry: { limit: 3, statusCodes: [503], delay: () => 0 },
      throwHttpErrors: false,
      hooks: {
        beforeRetry: ({ attempt }) => {
          attempts.push(attempt)
        },
      },
    })
    await m.get("https://x.test/")
    expect(attempts).toEqual([1, 2, 3])
  })
})

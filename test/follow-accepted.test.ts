import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { followAccepted } from "../src/poll/index.ts"

describe("followAccepted — 202 + Location async job pattern", () => {
  it("polls Location until until(data) is satisfied", async () => {
    let getCalls = 0
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        if (req.method === "POST") {
          return new Response(null, {
            status: 202,
            headers: { location: "https://api.test/jobs/42" },
          })
        }
        getCalls++
        const status = getCalls < 3 ? "pending" : "completed"
        return new Response(JSON.stringify({ status, jobId: "42" }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await followAccepted<{ status: string; jobId: string }>(m, {
      trigger: () => m.post("https://api.test/jobs", { foo: "bar" }),
      interval: 0,
      until: (data) => data.status === "completed",
    })
    expect(result.status).toBe("completed")
    expect(result.jobId).toBe("42")
    expect(getCalls).toBe(3)
  })

  it("short-circuits when trigger returns non-202", async () => {
    const driver = {
      name: "x",
      request: async (): Promise<Response> =>
        new Response(JSON.stringify({ status: "completed" }), {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const result = await followAccepted<{ status: string }>(m, {
      trigger: () => m.post("https://api.test/jobs", {}),
      until: (data) => data.status === "completed",
    })
    expect(result.status).toBe("completed")
  })

  it("throws when 202 is returned without a Location header", async () => {
    const driver = {
      name: "x",
      request: async (): Promise<Response> => new Response(null, { status: 202 }),
    }
    const m = createMisina({ driver, retry: 0 })
    await expect(
      followAccepted(m, {
        trigger: () => m.post("https://api.test/jobs", {}),
        until: () => true,
      }),
    ).rejects.toThrow(/Location/)
  })

  it("relative Location is resolved against trigger response URL", async () => {
    const seen: string[] = []
    const driver = {
      name: "x",
      request: async (req: Request): Promise<Response> => {
        seen.push(req.url)
        if (req.method === "POST") {
          // Same-origin relative location.
          return new Response(null, {
            status: 202,
            headers: { location: "/jobs/abc" },
          })
        }
        return new Response(JSON.stringify({ done: true }), {
          headers: { "content-type": "application/json" },
        })
      },
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://api.test" })
    await followAccepted<{ done: boolean }>(m, {
      trigger: () => m.post("/jobs", {}),
      until: (d) => d.done,
      interval: 0,
    })
    expect(seen).toContain("https://api.test/jobs/abc")
  })
})

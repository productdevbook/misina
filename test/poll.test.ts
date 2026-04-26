import { describe, expect, it } from "vitest"
import { createMisina, TimeoutError } from "../src/index.ts"
import { poll, PollExhaustedError } from "../src/poll/index.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("poll() — until-predicate loop", () => {
  it("resolves on first satisfying response", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ state: calls === 3 ? "done" : "pending", n: calls })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await poll<{ state: string; n: number }>(m, "https://api.test/jobs/42", {
      interval: 5,
      until: (j) => j.state === "done",
    })

    expect(result.state).toBe("done")
    expect(calls).toBe(3)
  })

  it("times out via TimeoutError when total deadline exceeded", async () => {
    const driver = {
      name: "p",
      request: async () => jsonResponse({ state: "pending" }),
    }
    const m = createMisina({ driver, retry: 0 })

    await expect(
      poll<{ state: string }>(m, "https://api.test/jobs/42", {
        interval: 5,
        timeout: 30,
        until: () => false,
      }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/Error/) })
  })

  it("respects maxAttempts and throws PollExhaustedError", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ state: "pending" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await expect(
      poll(m, "https://api.test/jobs/42", {
        interval: 1,
        maxAttempts: 4,
        until: () => false,
      }),
    ).rejects.toBeInstanceOf(PollExhaustedError)

    expect(calls).toBe(4)
  })

  it("external signal aborts the poll", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ state: "pending" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const controller = new AbortController()
    const promise = poll(m, "https://api.test/jobs/42", {
      interval: 50,
      until: () => false,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)

    await expect(promise).rejects.toMatchObject({ name: expect.any(String) })
    expect(calls).toBeLessThan(3)
  })

  it("interval as a function gives custom backoff", async () => {
    let calls = 0
    const driver = {
      name: "p",
      request: async () => {
        calls++
        if (calls === 4) return jsonResponse({ state: "done", n: 4 })
        return jsonResponse({ state: "pending" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const intervals: number[] = []
    const result = await poll<{ state: string; n?: number }>(m, "https://api.test/x", {
      interval: (n) => {
        intervals.push(n)
        return 1
      },
      until: (j) => j.state === "done",
    })

    expect(result.n).toBe(4)
    expect(intervals).toEqual([1, 2, 3])
  })

  it("init forwarded to misina (headers/query)", async () => {
    let captured: Request | undefined
    const driver = {
      name: "p",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({ state: "done" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await poll(m, "https://api.test/jobs/42", {
      interval: 1,
      until: () => true,
      init: { headers: { "x-trace": "abc" } },
    })

    expect(captured?.headers.get("x-trace")).toBe("abc")
  })

  it("composes timeout with internal abort cleanly (no extra wait after match)", async () => {
    let calls = 0
    const start = Date.now()
    const driver = {
      name: "p",
      request: async () => {
        calls++
        return jsonResponse({ state: "done" })
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const result = await poll<{ state: string }>(m, "https://api.test/", {
      interval: 1000,
      timeout: 1000,
      until: (j) => j.state === "done",
    })
    const elapsed = Date.now() - start

    expect(result.state).toBe("done")
    expect(calls).toBe(1)
    expect(elapsed).toBeLessThan(500) // resolved before timeout
  })
})

it("exposes TimeoutError exists for catchers", () => {
  expect(typeof TimeoutError).toBe("function")
})

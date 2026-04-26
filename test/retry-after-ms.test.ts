import { describe, expect, it, vi } from "vitest"
import { createMisina } from "../src/index.ts"

function makeRecordingDriver(responses: Response[]) {
  let i = 0
  const calls: number[] = []
  return {
    name: "rec",
    request: async () => {
      calls.push(Date.now())
      const r = responses[i] ?? responses[responses.length - 1]
      i++
      return r!.clone()
    },
    calls,
  }
}

describe("retry-after-ms (millisecond precision)", () => {
  it("honors retry-after-ms header before falling back to retry-after", async () => {
    vi.useFakeTimers()
    try {
      const driver = makeRecordingDriver([
        new Response("err", { status: 503, headers: { "retry-after-ms": "250" } }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ])
      const m = createMisina({
        driver,
        retry: { limit: 3, statusCodes: [503], afterStatusCodes: [503] },
      })
      const promise = m.get("https://x.test/")
      await vi.advanceTimersByTimeAsync(250)
      const r = await promise
      expect(r.status).toBe(200)
      expect(driver.calls.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retry-after-ms takes precedence over retry-after seconds", async () => {
    vi.useFakeTimers()
    try {
      const driver = makeRecordingDriver([
        new Response("err", {
          status: 503,
          headers: { "retry-after-ms": "100", "retry-after": "10" }, // 100ms vs 10s
        }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ])
      const m = createMisina({
        driver,
        retry: { limit: 3, statusCodes: [503], afterStatusCodes: [503] },
      })
      const promise = m.get("https://x.test/")
      // If retry-after (10s) won, advancing 100ms wouldn't fire retry yet.
      await vi.advanceTimersByTimeAsync(100)
      const r = await promise
      expect(r.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores malformed retry-after-ms (falls back to retry-after)", async () => {
    vi.useFakeTimers()
    try {
      const driver = makeRecordingDriver([
        new Response("err", {
          status: 503,
          headers: { "retry-after-ms": "abc", "retry-after": "0" },
        }),
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      ])
      const m = createMisina({
        driver,
        retry: { limit: 3, statusCodes: [503], afterStatusCodes: [503] },
      })
      const promise = m.get("https://x.test/")
      await vi.advanceTimersByTimeAsync(0)
      const r = await promise
      expect(r.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("x-should-retry header override", () => {
  it("x-should-retry: false on 503 prevents retry", async () => {
    const driver = makeRecordingDriver([
      new Response("err", { status: 503, headers: { "x-should-retry": "false" } }),
    ])
    const m = createMisina({
      driver,
      retry: { limit: 3, statusCodes: [503] },
      throwHttpErrors: false,
    })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(503)
    expect(driver.calls.length).toBe(1)
  })

  it("x-should-retry: true on 418 forces retry", async () => {
    const driver = makeRecordingDriver([
      new Response("err", { status: 418, headers: { "x-should-retry": "true" } }),
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ])
    const m = createMisina({
      driver,
      retry: { limit: 3, statusCodes: [503], delay: () => 0 }, // 418 not in default
    })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(200)
    expect(driver.calls.length).toBe(2)
  })

  it("malformed x-should-retry value falls through to default policy", async () => {
    const driver = makeRecordingDriver([
      new Response("err", { status: 503, headers: { "x-should-retry": "maybe" } }),
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ])
    const m = createMisina({
      driver,
      retry: { limit: 3, statusCodes: [503], delay: () => 0 },
    })
    const r = await m.get("https://x.test/")
    expect(r.status).toBe(200)
    expect(driver.calls.length).toBe(2)
  })

  it("x-should-retry: false respects method gate (no retry on POST anyway)", async () => {
    const driver = makeRecordingDriver([
      new Response("err", { status: 503, headers: { "x-should-retry": "true" } }),
    ])
    const m = createMisina({
      driver,
      retry: { limit: 3, statusCodes: [503] }, // POST not in default methods
      throwHttpErrors: false,
    })
    const r = await m.post("https://x.test/", { a: 1 })
    expect(r.status).toBe(503)
    expect(driver.calls.length).toBe(1)
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { CircuitOpenError, withCircuitBreaker } from "../src/breaker/index.ts"

function alwaysFailingDriver(status = 500) {
  return {
    name: "fail",
    request: async () => new Response(null, { status }),
  }
}

function okDriver() {
  return {
    name: "ok",
    request: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
  }
}

describe("withCircuitBreaker — state machine", () => {
  it("starts closed and lets requests through", async () => {
    const m = withCircuitBreaker(createMisina({ driver: okDriver(), retry: 0 }))
    expect(m.breaker.state()).toBe("closed")

    await m.get("https://api.test/")
    expect(m.breaker.state()).toBe("closed")
  })

  it("trips after failureThreshold consecutive 500s", async () => {
    const m = withCircuitBreaker(createMisina({ driver: alwaysFailingDriver(500), retry: 0 }), {
      failureThreshold: 3,
      halfOpenAfter: 50,
    })

    for (let i = 0; i < 3; i++) {
      await m.get("https://api.test/").catch(() => {})
    }
    expect(m.breaker.state()).toBe("open")
  })

  it("rejects fast with CircuitOpenError once open", async () => {
    const m = withCircuitBreaker(createMisina({ driver: alwaysFailingDriver(500), retry: 0 }), {
      failureThreshold: 2,
      halfOpenAfter: 50,
    })

    await m.get("https://api.test/").catch(() => {})
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")

    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it("does NOT count 4xx as a failure (client error)", async () => {
    const m = withCircuitBreaker(createMisina({ driver: alwaysFailingDriver(404), retry: 0 }), {
      failureThreshold: 2,
    })

    for (let i = 0; i < 5; i++) {
      await m.get("https://api.test/").catch(() => {})
    }
    expect(m.breaker.state()).toBe("closed")
  })

  it("transitions to half-open after halfOpenAfter ms, then closes on success", async () => {
    let calls = 0
    const driver = {
      name: "x",
      request: async () => {
        calls++
        if (calls <= 2) return new Response(null, { status: 500 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = withCircuitBreaker(createMisina({ driver, retry: 0 }), {
      failureThreshold: 2,
      halfOpenAfter: 30,
    })

    await m.get("https://api.test/").catch(() => {})
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")

    await new Promise((r) => setTimeout(r, 40))

    // Probe goes through and succeeds → close.
    const res = await m.get("https://api.test/")
    expect(res.status).toBe(200)
    expect(m.breaker.state()).toBe("closed")
  })

  it("probe failure puts breaker back to open with fresh timer", async () => {
    const m = withCircuitBreaker(createMisina({ driver: alwaysFailingDriver(500), retry: 0 }), {
      failureThreshold: 2,
      halfOpenAfter: 30,
    })

    await m.get("https://api.test/").catch(() => {})
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")

    await new Promise((r) => setTimeout(r, 40))

    // Probe fails → back to open.
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")
  })

  it(".breaker.trip() forces open immediately", async () => {
    const m = withCircuitBreaker(createMisina({ driver: okDriver(), retry: 0 }), {
      halfOpenAfter: 50,
    })
    expect(m.breaker.state()).toBe("closed")
    m.breaker.trip()
    expect(m.breaker.state()).toBe("open")
    await expect(m.get("https://api.test/")).rejects.toBeInstanceOf(CircuitOpenError)
  })

  it(".breaker.reset() forces back to closed", async () => {
    const m = withCircuitBreaker(createMisina({ driver: okDriver(), retry: 0 }))
    m.breaker.trip()
    expect(m.breaker.state()).toBe("open")
    m.breaker.reset()
    expect(m.breaker.state()).toBe("closed")

    const res = await m.get("https://api.test/")
    expect(res.status).toBe(200)
  })

  it("CircuitOpenError carries retryAfter ms", async () => {
    const m = withCircuitBreaker(createMisina({ driver: okDriver(), retry: 0 }), {
      halfOpenAfter: 1000,
    })
    m.breaker.trip()
    const err = (await m.get("https://api.test/").catch((e) => e)) as CircuitOpenError
    expect(err).toBeInstanceOf(CircuitOpenError)
    expect(err.retryAfter).toBeGreaterThan(0)
    expect(err.retryAfter).toBeLessThanOrEqual(1000)
  })

  it("custom isFailure overrides the 5xx-only default", async () => {
    const m = withCircuitBreaker(createMisina({ driver: alwaysFailingDriver(404), retry: 0 }), {
      failureThreshold: 2,
      isFailure: ({ error }) => error != null, // count any error as failure
    })

    await m.get("https://api.test/").catch(() => {})
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")
  })

  it("network errors count as failures by default", async () => {
    const driver = {
      name: "broken",
      request: async () => {
        throw Object.assign(new TypeError("fetch failed"), { name: "TypeError" })
      },
    }
    const m = withCircuitBreaker(createMisina({ driver, retry: 0 }), {
      failureThreshold: 2,
    })

    await m.get("https://api.test/").catch(() => {})
    await m.get("https://api.test/").catch(() => {})
    expect(m.breaker.state()).toBe("open")
  })
})

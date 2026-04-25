import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

describe("idempotencyKey: 'auto'", () => {
  it("sets a UUID Idempotency-Key on POST when retry > 0", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.post("https://api.test/", { x: 1 })
    expect(captured).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it("reuses the same key across retries", async () => {
    let calls = 0
    const seen: (string | null)[] = []
    const driver = {
      name: "flaky",
      request: async (req: Request) => {
        calls++
        seen.push(req.headers.get("idempotency-key"))
        if (calls < 3)
          return new Response(null, {
            status: 503,
            headers: { "retry-after": "0" },
          })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      // POST not retried by default — opt in via `methods`.
      retry: { limit: 5, delay: () => 1, methods: ["POST"] },
      idempotencyKey: "auto",
    })

    await m.post("https://api.test/", { x: 1 })
    expect(calls).toBe(3)
    // All three attempts saw the same key.
    expect(seen[0]).toBeTruthy()
    expect(seen[1]).toBe(seen[0])
    expect(seen[2]).toBe(seen[0])
  })

  it("does NOT set a key on GET (already idempotent)", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.get("https://api.test/")
    expect(captured).toBeNull()
  })

  it("does NOT set a key on PUT (already idempotent)", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.put("https://api.test/", { x: 1 })
    expect(captured).toBeNull()
  })

  it("does NOT set a key when retry is 0", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: 0,
      idempotencyKey: "auto",
    })

    await m.post("https://api.test/", { x: 1 })
    expect(captured).toBeNull()
  })

  it("user-supplied Idempotency-Key wins over 'auto'", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.post("https://api.test/", { x: 1 }, { headers: { "idempotency-key": "user-supplied" } })
    expect(captured).toBe("user-supplied")
  })

  it("string form: uses the literal value", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "fixed-key-123",
    })

    await m.post("https://api.test/", { x: 1 })
    expect(captured).toBe("fixed-key-123")
  })

  it("function form: called once with the request", async () => {
    let calls = 0
    const seen: (string | null)[] = []
    const driver = {
      name: "f",
      request: async (req: Request) => {
        calls++
        seen.push(req.headers.get("idempotency-key"))
        if (calls < 2) return new Response(null, { status: 503 })
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }

    let generatorCalls = 0
    const m = createMisina({
      driver,
      retry: { limit: 3, delay: () => 1, methods: ["POST"] },
      idempotencyKey: () => {
        generatorCalls++
        return `gen-${generatorCalls}`
      },
    })

    await m.post("https://api.test/", { x: 1 })

    // Generator should be called once, not per attempt.
    expect(generatorCalls).toBe(1)
    expect(seen[0]).toBe("gen-1")
    expect(seen[1]).toBe("gen-1")
  })

  it("DELETE gets a key (it's a mutation)", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({
      driver,
      retry: { limit: 1, delay: () => 1 },
      idempotencyKey: "auto",
    })

    await m.delete("https://api.test/users/42")
    expect(captured).toBeTruthy()
  })

  it("disabled by default (false): no key sent", async () => {
    let captured: string | null = null
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req.headers.get("idempotency-key")
        return new Response("{}", { headers: { "content-type": "application/json" } })
      },
    }
    const m = createMisina({ driver, retry: { limit: 1, delay: () => 1 } })

    await m.post("https://api.test/", { x: 1 })
    expect(captured).toBeNull()
  })
})

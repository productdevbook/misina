import { describe, expect, it } from "vitest"
import { createMisina, HTTPError, isHTTPError } from "../src/index.ts"

describe("MisinaResponse.requestId", () => {
  it("reads x-request-id by default", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: { "content-type": "application/json", "x-request-id": "req_abc123" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBe("req_abc123")
  })

  it("reads request-id (Anthropic style)", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: { "content-type": "application/json", "request-id": "msg_01abc" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBe("msg_01abc")
  })

  it("reads x-correlation-id", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: { "content-type": "application/json", "x-correlation-id": "corr_42" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBe("corr_42")
  })

  it("undefined when no candidate header is present", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBeUndefined()
  })

  it("custom requestIdHeaders order wins", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: {
            "content-type": "application/json",
            "x-request-id": "default",
            "cf-ray": "cloudflare-id",
          },
        }),
    }
    const m = createMisina({
      driver,
      retry: 0,
      requestIdHeaders: ["cf-ray", "x-request-id"],
    })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBe("cloudflare-id")
  })

  it("first non-empty header wins (skips empty)", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          headers: {
            "content-type": "application/json",
            "x-request-id": "",
            "request-id": "fallback_abc",
          },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get("https://x.test/")
    expect(r.requestId).toBe("fallback_abc")
  })
})

describe("HTTPError.requestId", () => {
  it("populates requestId on 4xx error", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 404,
          headers: { "content-type": "application/json", "x-request-id": "req_404" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await m.get("https://x.test/")
      expect.fail("should throw")
    } catch (err) {
      expect(isHTTPError(err)).toBe(true)
      expect((err as HTTPError).requestId).toBe("req_404")
    }
  })

  it("includes [req: <id>] in error message", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("err", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "x-request-id": "req_500" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await m.get("https://x.test/")
      expect.fail("should throw")
    } catch (err) {
      expect((err as Error).message).toContain("[req: req_500]")
    }
  })

  it("toJSON includes requestId", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response("err", {
          status: 500,
          headers: { "x-request-id": "req_serialize" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    try {
      await m.get("https://x.test/")
      expect.fail("should throw")
    } catch (err) {
      const json = (err as HTTPError).toJSON()
      expect(json.requestId).toBe("req_serialize")
    }
  })

  it("safe() error result.response.requestId is populated", async () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 404,
          headers: { "content-type": "application/json", "x-request-id": "req_safe" },
        }),
    }
    const m = createMisina({ driver, retry: 0 })
    const r = await m.safe.get("https://x.test/")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.response?.requestId).toBe("req_safe")
      expect((r.error as HTTPError).requestId).toBe("req_safe")
    }
  })
})

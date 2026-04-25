import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

describe("body serialization — pass-through types", () => {
  it("FormData passes through unchanged; content-type left to fetch (multipart boundary)", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const fd = new FormData()
    fd.append("name", "misina")
    fd.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt")

    await m.post("https://api.test/upload", fd)

    expect(captured).toBeDefined()
    // Misina must NOT set content-type for FormData; fetch sets the multipart
    // boundary. Our content-type, if any, is from defaults — not application/json.
    const ct = captured?.headers.get("content-type") ?? ""
    expect(ct.startsWith("multipart/form-data")).toBe(true)

    // And the body is reachable as FormData.
    const echoed = await captured?.formData()
    expect(echoed?.get("name")).toBe("misina")
  })

  it("URLSearchParams body sets application/x-www-form-urlencoded automatically (via fetch)", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const params = new URLSearchParams({ a: "1", b: "two" })
    await m.post("https://api.test/x", params)

    const ct = captured?.headers.get("content-type") ?? ""
    expect(ct).toContain("application/x-www-form-urlencoded")
    expect(await captured?.text()).toBe("a=1&b=two")
  })

  it("Blob body keeps its type; misina does not override content-type", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const blob = new Blob([JSON.stringify({ ok: true })], { type: "application/octet-stream" })
    await m.post("https://api.test/blob", blob)

    expect(captured?.headers.get("content-type")).toBe("application/octet-stream")
    const buf = await captured?.arrayBuffer()
    expect(new TextDecoder().decode(buf)).toBe('{"ok":true}')
  })

  it("ArrayBuffer body passes through; user-supplied content-type wins", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const buf = new TextEncoder().encode("hello").buffer
    await m.post("https://api.test/raw", buf, {
      headers: { "content-type": "application/x-binary" },
    })

    expect(captured?.headers.get("content-type")).toBe("application/x-binary")
    expect(await captured?.text()).toBe("hello")
  })

  it("Uint8Array body passes through unchanged", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    const bytes = new TextEncoder().encode("byte-stream")
    await m.post("https://api.test/raw", bytes, {
      headers: { "content-type": "application/octet-stream" },
    })

    expect(await captured?.text()).toBe("byte-stream")
  })

  it("plain object body sets application/json by default", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/json", { a: 1, b: "two" })
    expect(captured?.headers.get("content-type")).toBe("application/json")
    expect(await captured?.text()).toBe('{"a":1,"b":"two"}')
  })

  it("array body sets application/json by default", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/json", [1, 2, 3])
    expect(captured?.headers.get("content-type")).toBe("application/json")
    expect(await captured?.text()).toBe("[1,2,3]")
  })

  it("user-supplied content-type is respected for plain objects", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.post(
      "https://api.test/json",
      { a: 1 },
      { headers: { "content-type": "application/vnd.api+json" } },
    )
    expect(captured?.headers.get("content-type")).toBe("application/vnd.api+json")
  })

  it("class instance with toJSON() is serialized through it", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    class Pt {
      constructor(
        public x: number,
        public y: number,
      ) {}
      toJSON() {
        return [this.x, this.y]
      }
    }

    await m.post("https://api.test/p", new Pt(3, 4))
    expect(captured?.headers.get("content-type")).toBe("application/json")
    expect(await captured?.text()).toBe("[3,4]")
  })

  it("class instance without toJSON() is rejected — would silently send {}", async () => {
    const m = createMisina({
      driver: { name: "f", request: async () => jsonResponse({}) },
      retry: 0,
    })

    class NotPlain {
      data = 1
    }

    await expect(m.post("https://api.test/x", new NotPlain())).rejects.toThrow(
      /non-plain object|toJSON/i,
    )
  })

  it("string body is sent verbatim", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    await m.post("https://api.test/s", "raw text", {
      headers: { "content-type": "text/plain" },
    })
    expect(await captured?.text()).toBe("raw text")
  })
})

describe("body serialization — body-method gate", () => {
  it("GET with body is dropped silently (RFC says SHOULD NOT)", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    // not a normal usage; we want to assert body is dropped for GET
    await m.get("https://api.test/g", { body: { a: 1 } })

    expect(captured?.method).toBe("GET")
    // Body must be empty — runtime would have thrown otherwise.
    expect(await captured?.text()).toBe("")
  })

  it("DELETE may carry a JSON body via { body }", async () => {
    let captured: Request | undefined
    const driver = {
      name: "f",
      request: async (req: Request) => {
        captured = req
        return jsonResponse({})
      },
    }
    const m = createMisina({ driver, retry: 0 })

    // DELETE follows the same shape as GET (no positional body) — RFC 9110
    // permits a body; pass it via { body } to keep the option-bag API
    // consistent with axios/ky/ofetch.
    await m.delete("https://api.test/d", { body: { reason: "expired" } })
    expect(captured?.method).toBe("DELETE")
    expect(captured?.headers.get("content-type")).toBe("application/json")
    expect(await captured?.text()).toBe('{"reason":"expired"}')
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import {
  createTestMisina,
  record,
  recordToJSON,
  replayFromJSON,
  type Cassette,
} from "../src/test/index.ts"

describe("record / recordToJSON / replayFromJSON", () => {
  it("round-trips a captured call through a JSON cassette", async () => {
    // Step 1: a "real" misina backed by a fake server.
    let serverHits = 0
    const driver = {
      name: "real",
      request: async (req: Request) => {
        serverHits++
        if (req.url.endsWith("/users/42")) {
          return new Response(JSON.stringify({ id: 42, name: "Ada" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response("not found", { status: 404 })
      },
    }
    const real = createMisina({ driver, retry: 0 })
    const { client: recorded, calls } = record(real)

    const live = await recorded.get<{ id: number; name: string }>("https://api.test/users/42")
    expect(live.data).toEqual({ id: 42, name: "Ada" })
    expect(serverHits).toBe(1)

    const cassette: Cassette = await recordToJSON(calls)
    expect(cassette).toHaveLength(1)
    expect(cassette[0]?.request.method).toBe("GET")
    expect(cassette[0]?.request.url).toBe("https://api.test/users/42")
    expect(cassette[0]?.response.status).toBe(200)
    expect(JSON.parse(cassette[0]?.response.body ?? "{}")).toEqual({
      id: 42,
      name: "Ada",
    })

    // Step 2: replay the cassette through createTestMisina with NO real
    // driver — every call goes through the cassette.
    const handler = replayFromJSON(cassette)
    const t = createTestMisina({ routes: { "GET /users/:id": handler } })
    const replayed = await t.client.get<{ id: number; name: string }>("https://api.test/users/42")
    expect(replayed.data).toEqual({ id: 42, name: "Ada" })
    // Server was not called again.
    expect(serverHits).toBe(1)
  })

  it("custom matcher can branch on a query param", async () => {
    const cassette: Cassette = [
      {
        request: {
          method: "GET",
          url: "https://api.test/search?q=cat",
          headers: {},
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"hits":["cat1"]}',
        },
      },
      {
        request: {
          method: "GET",
          url: "https://api.test/search?q=dog",
          headers: {},
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"hits":["dog1"]}',
        },
      },
    ]
    const handler = replayFromJSON(cassette, {
      match: (request, entry) => {
        if (request.method !== entry.request.method) return false
        const a = new URL(request.url)
        const b = new URL(entry.request.url)
        return a.pathname === b.pathname && a.searchParams.get("q") === b.searchParams.get("q")
      },
    })
    const t = createTestMisina({ routes: { "GET /search": handler } })
    const cat = await t.client.get<{ hits: string[] }>("https://api.test/search?q=cat")
    const dog = await t.client.get<{ hits: string[] }>("https://api.test/search?q=dog")
    expect(cat.data.hits).toEqual(["cat1"])
    expect(dog.data.hits).toEqual(["dog1"])
  })

  it("throws when no cassette entry matches", async () => {
    const cassette: Cassette = [
      {
        request: { method: "GET", url: "https://api.test/a", headers: {} },
        response: { status: 200, headers: {}, body: "a" },
      },
    ]
    const handler = replayFromJSON(cassette)
    const t = createTestMisina({ routes: { "GET /:p": handler } })
    await expect(t.client.get("https://api.test/missing")).rejects.toBeDefined()
  })

  it("consume=true means each entry is used once", async () => {
    const cassette: Cassette = [
      {
        request: { method: "GET", url: "https://api.test/x", headers: {} },
        response: { status: 200, headers: {}, body: "first" },
      },
      {
        request: { method: "GET", url: "https://api.test/x", headers: {} },
        response: { status: 200, headers: {}, body: "second" },
      },
    ]
    const handler = replayFromJSON(cassette)
    const t = createTestMisina({ routes: { "GET /x": handler } })
    const r1 = await t.client.get("https://api.test/x")
    const r2 = await t.client.get("https://api.test/x")
    expect(r1.data).toBe("first")
    expect(r2.data).toBe("second")
  })

  it("consume=false reuses the first match every time", async () => {
    const cassette: Cassette = [
      {
        request: { method: "GET", url: "https://api.test/x", headers: {} },
        response: { status: 200, headers: {}, body: "always" },
      },
    ]
    const handler = replayFromJSON(cassette, { consume: false })
    const t = createTestMisina({ routes: { "GET /x": handler } })
    const r1 = await t.client.get("https://api.test/x")
    const r2 = await t.client.get("https://api.test/x")
    expect(r1.data).toBe("always")
    expect(r2.data).toBe("always")
  })
})

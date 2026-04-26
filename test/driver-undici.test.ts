import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { Agent } from "undici"
import { createMisina } from "../src/index.ts"
import { undiciDriver } from "../src/driver/undici.ts"

let server: Server
let baseUrl: string
let hits = 0
let socketsSeen = new Set<unknown>()

beforeAll(async () => {
  hits = 0
  socketsSeen = new Set()
  server = createServer((req, res) => {
    hits++
    socketsSeen.add(req.socket)
    if (req.url?.startsWith("/echo-headers")) {
      const out = JSON.stringify({
        method: req.method,
        connection: req.headers.connection ?? null,
        // Echo a header so we can prove the request body / headers
        // travelled through the dispatcher unchanged.
        accept: req.headers.accept ?? null,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(out)
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ hits, url: req.url }))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("listen failed")
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("undiciDriver", () => {
  it("routes requests through the supplied dispatcher and returns a real Response", async () => {
    const dispatcher = new Agent({ keepAliveTimeout: 5_000, connections: 4 })
    const m = createMisina({
      driver: undiciDriver({ dispatcher }),
      retry: 0,
    })
    const r = await m.get<{ hits: number; url: string }>(`${baseUrl}/users/42`)
    expect(r.status).toBe(200)
    expect(r.data.hits).toBe(1)
    expect(r.data.url).toBe("/users/42")
    // undici ships its own WebIDL Response that's structurally
    // equivalent but a different constructor. Check duck-type.
    expect(typeof r.raw.status).toBe("number")
    expect(typeof r.raw.headers.get).toBe("function")
    expect(r.raw.url).toContain("/users/42")
    await dispatcher.close()
  })

  it("reuses one dispatcher across many requests (connection pool)", async () => {
    const dispatcher = new Agent({ keepAliveTimeout: 5_000, connections: 1 })
    const m = createMisina({
      driver: undiciDriver({ dispatcher }),
      retry: 0,
    })
    const before = socketsSeen.size
    await Promise.all([m.get(`${baseUrl}/a`), m.get(`${baseUrl}/b`), m.get(`${baseUrl}/c`)])
    // With `connections: 1` and Keep-Alive, undici reuses the same
    // socket — the server should observe at most one new socket on
    // top of whatever was open before. (We're tolerant: undici may
    // open up to `connections` sockets; the point is the pool is
    // bounded, not that it's exactly 1.)
    const newSockets = socketsSeen.size - before
    expect(newSockets).toBeLessThanOrEqual(1)
    await dispatcher.close()
  })

  it("forwards request headers + method through to the server", async () => {
    const dispatcher = new Agent({ keepAliveTimeout: 1_000 })
    const m = createMisina({
      driver: undiciDriver({ dispatcher }),
      retry: 0,
      headers: { accept: "application/json" },
    })
    const r = await m.get<{ method: string; accept: string }>(`${baseUrl}/echo-headers`)
    expect(r.data.method).toBe("GET")
    expect(r.data.accept).toBe("application/json")
    await dispatcher.close()
  })

  it("custom `fetch` override bypasses the dynamic import", async () => {
    let stubCalled = 0
    let observedDispatcher: unknown
    const stub = async (input: Request, init?: { dispatcher?: unknown }) => {
      stubCalled++
      observedDispatcher = init?.dispatcher
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const dispatcher = { __marker: true }
    const m = createMisina({
      driver: undiciDriver({
        dispatcher: dispatcher as never,
        fetch: stub as never,
      }),
      retry: 0,
    })
    const r = await m.get<{ ok: boolean }>(`${baseUrl}/whatever`)
    expect(r.data.ok).toBe(true)
    expect(stubCalled).toBe(1)
    expect(observedDispatcher).toBe(dispatcher)
  })
})

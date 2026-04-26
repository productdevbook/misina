import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Socket } from "node:net"
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2"
import { createMisina } from "../src/index.ts"
import { http2Driver } from "../src/driver/http2.ts"

let server: Http2Server
let baseUrl: string
let requestsSeen = 0
// Track every accepted socket. `Http2Server.close()` waits for every
// open connection to drain, and `closeAllConnections()` lives on
// `http.Server` only — not `http2.Http2Server`. We destroy sockets
// manually on teardown so the close callback fires immediately.
const sockets = new Set<Socket>()
const drivers: Array<{ dispose: () => Promise<void> }> = []
function track<T extends { dispose: () => Promise<void> }>(driver: T): T {
  drivers.push(driver)
  return driver
}

beforeAll(async () => {
  requestsSeen = 0
  server = createServer()
  server.on("connection", (socket: Socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    requestsSeen++
    const path = (headers[":path"] as string) ?? "/"
    if (path.startsWith("/echo")) {
      const chunks: Buffer[] = []
      stream.on("data", (c) => chunks.push(c as Buffer))
      stream.on("end", () => {
        stream.respond({
          ":status": 200,
          "content-type": "application/json",
        })
        stream.end(
          JSON.stringify({
            method: headers[":method"],
            path,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      })
      return
    }
    stream.respond({ ":status": 200, "content-type": "application/json" })
    stream.end(JSON.stringify({ path, n: requestsSeen }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("listen failed")
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  // Tear down every client session first.
  await Promise.all(drivers.map((d) => d.dispose().catch(() => undefined)))
  drivers.length = 0
  // Destroy every socket we ever accepted. `Http2Server.close()` waits
  // on open sockets and `closeAllConnections()` is `http.Server`-only,
  // so without this `close()` blocks until the OS times out the
  // connection — which is what failed CI on Node 22.
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("http2Driver", () => {
  it("returns a Response from a single GET", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const r = await m.get<{ path: string; n: number }>(`${baseUrl}/users/1`)
    expect(r.status).toBe(200)
    expect(r.data.path).toBe("/users/1")
    expect(r.data.n).toBeGreaterThan(0)
  })

  it("multiplexes concurrent streams over a single session", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const before = requestsSeen
    const results = await Promise.all([
      m.get<{ path: string }>(`${baseUrl}/a`),
      m.get<{ path: string }>(`${baseUrl}/b`),
      m.get<{ path: string }>(`${baseUrl}/c`),
    ])
    expect(results.map((r) => r.data.path).sort()).toEqual(["/a", "/b", "/c"])
    expect(requestsSeen).toBe(before + 3)
  })

  it("forwards POST body bytes through the stream", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const r = await m.post<{ method: string; body: string }>(`${baseUrl}/echo`, { hi: "there" })
    expect(r.data.method).toBe("POST")
    expect(JSON.parse(r.data.body)).toEqual({ hi: "there" })
  })

  it("aborting the signal destroys the stream", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const ac = new AbortController()
    queueMicrotask(() => ac.abort())
    await expect(m.get(`${baseUrl}/users/will-cancel`, { signal: ac.signal })).rejects.toBeDefined()
  })
})

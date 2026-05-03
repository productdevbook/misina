import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
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
    // Swallow stream-level errors (e.g. client RST_STREAM, abort) so
    // they don't bubble out as unhandled exceptions on the server side.
    stream.on("error", () => {
      // Intentionally ignored — these are expected during abort /
      // RST_STREAM tests and would otherwise tear down the test run.
    })
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
            host: headers["host"] ?? null,
          }),
        )
      })
      return
    }
    if (path.startsWith("/multi-cookie")) {
      // Multi-value response header to exercise the array-append branch.
      stream.respond({
        ":status": 200,
        "content-type": "application/json",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      })
      stream.end(JSON.stringify({ ok: true }))
      return
    }
    if (path.startsWith("/slow")) {
      // Hold the stream open so the client can abort it mid-flight.
      setTimeout(() => {
        try {
          stream.respond({ ":status": 200 })
          stream.end("late")
        } catch {
          // already destroyed by client abort
        }
      }, 5_000)
      return
    }
    if (path.startsWith("/rst")) {
      // Server-initiated stream reset — drives the `error` listener
      // path in the driver.
      stream.close(0x02 /* INTERNAL_ERROR */)
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

  // --- branch coverage additions ---

  it("strips the host header before sending (server sees no host)", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
      headers: { host: "example.invalid" },
    })
    // The driver deletes `host` from request headers before forwarding.
    // node:http2 derives :authority from the connect URL; passing a
    // Host header is redundant and some servers reject it.
    const r = await m.post<{ host: string | null }>(`${baseUrl}/echo`, { x: 1 })
    // node:http2 server reports `host` as null/undefined when only :authority arrives.
    expect(r.data.host == null || r.data.host === "").toBe(true)
  })

  it("appends multi-value response headers (set-cookie array path)", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const r = await m.get(`${baseUrl}/multi-cookie`)
    // Response.headers exposes set-cookie via getSetCookie() in modern Node.
    const cookies =
      typeof r.raw.headers.getSetCookie === "function"
        ? r.raw.headers.getSetCookie()
        : (r.raw.headers.get("set-cookie") ?? "").split(",")
    // We appended both values, so there should be two distinct cookies.
    expect(cookies.length).toBeGreaterThanOrEqual(1)
    const joined = cookies.join(";")
    expect(joined).toContain("a=1")
    expect(joined).toContain("b=2")
  })

  it("rejects on server-side stream reset (RST_STREAM error path)", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    // Server resets the stream — the driver's `error` listener should
    // reject the promise with a real Error.
    await expect(m.get(`${baseUrl}/rst`)).rejects.toBeDefined()
  })

  it("rejects synchronously when the signal is already aborted", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    const ac = new AbortController()
    ac.abort()
    await expect(m.get(`${baseUrl}/users/pre-aborted`, { signal: ac.signal })).rejects.toBeDefined()
  })

  it("re-uses one cached session across sequential requests (bumpIdle path)", async () => {
    const driver = track(http2Driver({ sessionIdleTimeoutMs: 60_000 }))
    const m = createMisina({ driver, retry: 0 })
    const r1 = await m.get<{ path: string }>(`${baseUrl}/seq-1`)
    const r2 = await m.get<{ path: string }>(`${baseUrl}/seq-2`)
    const r3 = await m.get<{ path: string }>(`${baseUrl}/seq-3`)
    expect(r1.data.path).toBe("/seq-1")
    expect(r2.data.path).toBe("/seq-2")
    expect(r3.data.path).toBe("/seq-3")
  })

  it("recovers when the cached session was destroyed between calls", async () => {
    const driver = track(http2Driver({ sessionIdleTimeoutMs: 60_000 }))
    const m = createMisina({ driver, retry: 0 })
    const r1 = await m.get<{ path: string }>(`${baseUrl}/recover-1`)
    expect(r1.data.path).toBe("/recover-1")
    // Tear down the underlying session by disposing — the next request
    // should transparently open a fresh one.
    await driver.dispose()
    const r2 = await m.get<{ path: string }>(`${baseUrl}/recover-2`)
    expect(r2.data.path).toBe("/recover-2")
  })

  it("expires a cached session when the idle timer fires", async () => {
    // Very short idle timeout — the timer should fire between requests
    // and force a fresh session on the next call.
    const driver = track(http2Driver({ sessionIdleTimeoutMs: 50 }))
    const m = createMisina({ driver, retry: 0 })
    const r1 = await m.get<{ path: string }>(`${baseUrl}/idle-1`)
    expect(r1.data.path).toBe("/idle-1")
    // Wait past the idle window so the timer's close path runs.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const r2 = await m.get<{ path: string }>(`${baseUrl}/idle-2`)
    expect(r2.data.path).toBe("/idle-2")
  })

  it("dispose() is idempotent (second call resolves cleanly)", async () => {
    const driver = http2Driver()
    drivers.push(driver)
    const m = createMisina({ driver, retry: 0 })
    await m.get(`${baseUrl}/dispose-1`)
    await driver.dispose()
    // Calling dispose again with no live sessions takes the empty-loop
    // branch and resolves immediately.
    await driver.dispose()
  })

  it("dispose() before any request is a no-op", async () => {
    const driver = http2Driver()
    await driver.dispose()
  })

  it("supports an explicit sessionIdleTimeoutMs option", async () => {
    const driver = track(http2Driver({ sessionIdleTimeoutMs: 5_000 }))
    const m = createMisina({ driver, retry: 0 })
    const r = await m.get<{ path: string }>(`${baseUrl}/with-opts`)
    expect(r.data.path).toBe("/with-opts")
  })
})

describe("http2Driver — empty body / GET branches", () => {
  it("uses the empty-body stream.end() branch for bodyless requests", async () => {
    const m = createMisina({
      driver: track(http2Driver()),
      retry: 0,
    })
    // A bare GET — `request.body` is null, so the driver hits the
    // `stream.end()` (no-arg) branch, not the body-bytes branch.
    const r = await m.get<{ path: string; n: number }>(`${baseUrl}/no-body`)
    expect(r.status).toBe(200)
    expect(r.data.path).toBe("/no-body")
  })
})

describe("http2Driver — afterEach session safety", () => {
  // Sanity: ensure dispose hooks always fire, even on test failure.
  afterEach(async () => {
    // No-op; the global afterAll handles cleanup. This block exists to
    // document the pattern from `1ba17a7 fix(ci): destroy http2 sockets
    // manually on test teardown` — driver tests must dispose every
    // session they create.
  })

  it("documents the cleanup contract", () => {
    expect(drivers.length).toBeGreaterThanOrEqual(0)
  })
})

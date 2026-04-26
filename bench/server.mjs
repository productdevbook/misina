// Tiny HTTP fixture used by every bench suite. Returns deterministic
// JSON for `/users/:id`, accepts JSON POSTs at `/echo`, and tracks a
// flake counter on `/flaky` so retry suites can exercise 503 → 200.

import { createServer } from "node:http"

export function startServer(port = 0) {
  const flake = new Map() // path -> remaining failures

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")

    if (url.pathname.startsWith("/users/")) {
      const id = url.pathname.slice("/users/".length)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id, name: `user-${id}` }))
      return
    }

    if (url.pathname === "/echo" && req.method === "POST") {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8")
        res.writeHead(200, { "content-type": "application/json" })
        res.end(body)
      })
      return
    }

    if (url.pathname === "/flaky") {
      const key = url.searchParams.get("key") ?? "default"
      const remaining = flake.get(key) ?? Number(url.searchParams.get("fail") ?? "1")
      if (remaining > 0) {
        flake.set(key, remaining - 1)
        res.writeHead(503, { "content-type": "text/plain" })
        res.end("flaky")
        return
      }
      flake.delete(key)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r(undefined))
          }),
      })
    })
  })
}

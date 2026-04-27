import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { isHTTPError, isMisinaError } from "misina"
import { type Post, upstream, type User } from "./api"

const app = new Hono()

// Inbound request-id middleware. Propagates the header to misina via
// per-call meta so the upstream sees the same id.
app.use(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID()
  c.set("requestId", requestId)
  c.header("x-request-id", requestId)
  await next()
})

app.get("/users/:id", async (c) => {
  const id = c.req.param("id")
  const requestId = c.get("requestId") as string
  try {
    const res = await upstream.get<User>(`/users/${id}`, { meta: { requestId } })
    return c.json({ id: res.data.id, name: res.data.name, email: res.data.email })
  } catch (err) {
    return mapError(c, err)
  }
})

app.get("/users/:id/posts", async (c) => {
  const id = c.req.param("id")
  const requestId = c.get("requestId") as string
  try {
    const res = await upstream.get<Post[]>("/posts", {
      query: { userId: id },
      meta: { requestId },
    })
    return c.json(res.data.map((p) => ({ id: p.id, title: p.title })))
  } catch (err) {
    return mapError(c, err)
  }
})

function mapError(c: Parameters<Parameters<typeof app.get>[1]>[0], err: unknown) {
  if (isHTTPError(err)) {
    // Forward upstream status + RFC 9457 problem+json verbatim when
    // present, otherwise synthesize a minimal one.
    return c.json(
      err.problem ?? { type: "about:blank", status: err.status, title: err.message },
      err.status as 400 | 401 | 403 | 404 | 500 | 502 | 503 | 504,
    )
  }
  if (isMisinaError(err)) return c.json({ title: err.name, detail: err.message }, 502)
  return c.json({ title: "InternalError" }, 500)
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string
  }
}

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`hono + misina listening on http://localhost:${info.port}`)
})

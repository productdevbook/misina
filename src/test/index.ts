import { createMisina } from "../misina.ts"
import mockDriverFactory, { type MockCall } from "../driver/mock.ts"
import type { HttpMethod, Misina, MisinaOptions } from "../types.ts"

export interface TestRouteContext {
  url: URL
  method: HttpMethod
  request: Request
  params: Record<string, string>
}

export type TestRouteResponse = Response | TestResponseInit | Promise<Response | TestResponseInit>

export interface TestResponseInit {
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: unknown
  /** Simulate latency (ms) before responding. */
  delay?: number
  /** Throw a network-style error instead of responding. */
  throw?: Error | string
}

export type TestRouteHandler = (ctx: TestRouteContext) => TestRouteResponse

export interface TestRoutes {
  [pattern: string]: TestRouteHandler | TestResponseInit
}

export interface CreateTestMisinaOptions extends MisinaOptions {
  routes?: TestRoutes
  /** Throw when a request hits no route. Default: true. */
  strict?: boolean
}

export interface TestMisina {
  client: Misina
  calls: readonly MockCall[]
  reset: () => void
  lastCall: () => MockCall | undefined
}

/**
 * Build a Misina instance backed by an in-memory mock driver. Routes are
 * matched by `METHOD /path` patterns supporting `:param` syntax. Records
 * every request for assertion in tests.
 */
export function createTestMisina(opts: CreateTestMisinaOptions = {}): TestMisina {
  const { routes, strict = true, ...misinaOpts } = opts
  const matchers = compileRoutes(routes)

  const calls: MockCall[] = []

  const driver = mockDriverFactory({
    handler: async (request) => {
      calls.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.clone().text() : undefined,
      })

      const url = new URL(request.url)
      const method = request.method.toUpperCase() as HttpMethod

      for (const matcher of matchers) {
        const params = matcher.match(method, url.pathname)
        if (!params) continue
        const out = await matcher.handler({ url, method, request, params })
        return toResponse(out)
      }

      if (strict) {
        throw new Error(`createTestMisina: no route matched ${method} ${url.pathname}`)
      }
      return new Response(null, { status: 404 })
    },
  })

  const client = createMisina({ ...misinaOpts, driver })

  return {
    client,
    calls,
    reset: (): void => {
      calls.length = 0
    },
    lastCall: (): MockCall | undefined => calls[calls.length - 1],
  }
}

interface CompiledRoute {
  match: (method: HttpMethod, path: string) => Record<string, string> | null
  handler: TestRouteHandler
}

function compileRoutes(routes: TestRoutes | undefined): CompiledRoute[] {
  if (!routes) return []
  return Object.entries(routes).map(([pattern, def]) => {
    const handler: TestRouteHandler = typeof def === "function" ? def : () => def
    const [methodPart, pathPart] = splitPattern(pattern)
    const { regex, paramNames } = pathToRegex(pathPart)
    return {
      match(method, path) {
        if (methodPart !== "*" && method !== methodPart) return null
        const m = regex.exec(path)
        if (!m) return null
        const params: Record<string, string> = {}
        paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? "")
        })
        return params
      },
      handler,
    }
  })
}

function splitPattern(pattern: string): [HttpMethod | "*", string] {
  const trimmed = pattern.trim()
  const space = trimmed.indexOf(" ")
  if (space === -1) return ["*", trimmed]
  const method = trimmed.slice(0, space).toUpperCase() as HttpMethod
  const path = trimmed.slice(space + 1)
  return [method, path]
}

function pathToRegex(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = []
  const regexBody = path
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name)
      return "([^/]+)"
    })
    .replace(/\*/g, ".*")
  return { regex: new RegExp(`^${regexBody}$`), paramNames }
}

async function toResponse(out: Response | TestResponseInit): Promise<Response> {
  if (out instanceof Response) return out
  if (out.delay && out.delay > 0) {
    await new Promise<void>((r) => setTimeout(r, out.delay))
  }
  if (out.throw) {
    throw typeof out.throw === "string" ? new TypeError(out.throw) : out.throw
  }
  const headers: Record<string, string> = { ...out.headers }
  const body = serializeTestBody(out.body, headers)
  return new Response(body, {
    status: out.status ?? 200,
    statusText: out.statusText,
    headers,
  })
}

function serializeTestBody(body: unknown, headers: Record<string, string>): BodyInit | null {
  if (body == null) return null
  if (typeof body === "string" || body instanceof Blob || body instanceof ArrayBuffer) {
    return body as BodyInit
  }
  if (!hasContentType(headers)) headers["content-type"] = "application/json"
  return JSON.stringify(body)
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
}

export type { MockCall } from "../driver/mock.ts"

/* ----------------------------------------------------------------------- */
/*                          record / replay cassettes                       */
/* ----------------------------------------------------------------------- */

/** A serialized request/response pair, JSON-stable across runtimes. */
export interface CassetteEntry {
  request: {
    method: string
    url: string
    headers: Record<string, string>
    /** UTF-8 body when present; binary bodies are base64-prefixed. */
    body?: string
  }
  response: {
    status: number
    statusText?: string
    headers: Record<string, string>
    body?: string
  }
}

export type Cassette = CassetteEntry[]

export interface RecordedCall {
  request: Request
  response: Response
}

/** Match strategy when looking up a recorded entry on replay. */
export type CassetteMatcher = (request: Request, entry: CassetteEntry, index: number) => boolean

const defaultMatcher: CassetteMatcher = (request, entry) =>
  request.method === entry.request.method && request.url === entry.request.url

/**
 * Wrap a Misina with a recorder that captures every request/response
 * pair flowing through it. Returns the wrapped client plus a `calls`
 * array suitable for `recordToJSON`.
 *
 * Records run on the `afterResponse` hook, so any response that comes
 * back through the misina pipeline is captured — including 4xx/5xx and
 * driver-level mock responses.
 */
export function record(misina: Misina): {
  client: Misina
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const client = misina.extend({
    hooks: {
      afterResponse: (ctx) => {
        if (ctx.response) {
          calls.push({ request: ctx.request, response: ctx.response.clone() })
        }
      },
    },
  })
  return { client, calls }
}

/**
 * Serialize recorded calls to a JSON-stable cassette. Bodies are read
 * fully via `clone().text()`, so the originals stay readable. Headers
 * are normalized to lowercase keys for deterministic equality.
 */
export async function recordToJSON(calls: RecordedCall[]): Promise<Cassette> {
  const out: Cassette = []
  for (const c of calls) {
    out.push({
      request: {
        method: c.request.method,
        url: c.request.url,
        headers: headersToObject(c.request.headers),
        body: c.request.body ? await c.request.clone().text() : undefined,
      },
      response: {
        status: c.response.status,
        statusText: c.response.statusText || undefined,
        headers: headersToObject(c.response.headers),
        body: await c.response.clone().text(),
      },
    })
  }
  return out
}

/**
 * Build a replay handler from a cassette. The result plugs into
 * `createTestMisina({ replay: cassette, replayMatch })` (below) — when
 * a request is issued, the first cassette entry whose matcher returns
 * true is consumed; subsequent calls advance through unconsumed
 * entries.
 *
 * Default matcher pairs entries by method + url. Pass a custom
 * `match` callback to also branch on body, headers, or query order.
 */
export function replayFromJSON(
  cassette: Cassette,
  options: { match?: CassetteMatcher; consume?: boolean } = {},
): TestRouteHandler {
  const match = options.match ?? defaultMatcher
  const consume = options.consume ?? true
  const remaining = cassette.map((e, i) => ({ entry: e, index: i, used: false }))
  return ({ request }) => {
    const found = remaining.find(
      (slot) => (!consume || !slot.used) && match(request, slot.entry, slot.index),
    )
    if (!found) {
      throw new Error(`replayFromJSON: no cassette entry matched ${request.method} ${request.url}`)
    }
    found.used = true
    return new Response(found.entry.response.body ?? null, {
      status: found.entry.response.status,
      statusText: found.entry.response.statusText,
      headers: found.entry.response.headers,
    })
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of headers.entries()) out[k.toLowerCase()] = v
  return out
}

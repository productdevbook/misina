<p align="center">
  <br>
  <img src=".github/assets/cover.svg" alt="misina — Driver-based, zero-dependency TypeScript HTTP client" width="100%">
  <br><br>
  <b style="font-size: 2em;">misina</b>
  <br><br>
  Driver-based, zero-dependency TypeScript HTTP client.
  <br>
  Hooks lifecycle, retry with <code>Retry-After</code>, error taxonomy, redirect header policy. Pure TypeScript, works everywhere.
  <br><br>
  <a href="https://npmjs.com/package/misina"><img src="https://img.shields.io/npm/v/misina?style=flat&colorA=18181B&colorB=06b6d4" alt="npm version"></a>
  <a href="https://npmjs.com/package/misina"><img src="https://img.shields.io/npm/dm/misina?style=flat&colorA=18181B&colorB=06b6d4" alt="npm downloads"></a>
  <a href="https://bundlephobia.com/result?p=misina"><img src="https://img.shields.io/bundlephobia/minzip/misina?style=flat&colorA=18181B&colorB=06b6d4" alt="bundle size"></a>
  <a href="https://github.com/productdevbook/misina/blob/main/LICENSE"><img src="https://img.shields.io/github/license/productdevbook/misina?style=flat&colorA=18181B&colorB=06b6d4" alt="license"></a>
</p>

---

## Table of Contents

- [Highlights](#highlights)
- [Install](#install)
- [Quick Start](#quick-start)
- [API](#api)
  - [createMisina](#createmisinaoptions)
  - [Hooks](#hooks)
  - [Retry](#retry)
  - [Errors](#errors)
  - [Status-Based Catchers](#status-based-catchers)
  - [validateResponse](#validateresponse)
  - [Custom JSON](#custom-json)
  - [.extend() and replaceOption](#extend-and-replaceoption)
  - [Drivers](#drivers)
- [Subpaths](#subpaths)
  - [misina/test](#misinatest)
  - [misina/auth](#misinaauth)
  - [misina/cookie](#misinacookie)
  - [misina/cache](#misinacache)
  - [misina/dedupe](#misinadedupe)
  - [misina/paginate](#misinapaginate)
  - [misina/stream](#misinastream)
- [Progress Events](#progress-events)
- [defer — Late-Binding Config](#defer--late-binding-config)
- [Type-Safe Path Generics](#type-safe-path-generics)
- [OpenAPI](#openapi)
- [Standard Schema Validation](#standard-schema-validation)
- [Security Defaults](#security-defaults)
- [Compared To](#compared-to)

## Highlights

- **Zero deps** in the core. Optional peers only.
- **ESM-only**, tree-shakeable, sub-path exports for everything beyond the core.
- **Driver pattern** — swap the transport. Default driver wraps `globalThis.fetch`; ship a mock or your own.
- **Hooks lifecycle** — `init`, `beforeRequest`, `beforeRetry`, `beforeRedirect`, `afterResponse`, `beforeError`. Default + per-request hooks concatenate.
- **Retry** with `Retry-After` / `RateLimit-Reset` parsing, jitter, `backoffLimit`, custom `shouldRetry`. `NetworkError` retried independently from `HTTPError`.
- **Redirect policy** — manual follow with cross-origin auth/cookie stripping by default. `https → http` downgrade refused.
- **`validateResponse`** — predicate sees status + parsed body, lets `200 { ok: false }` count as failure.
- **Standard Schema** support for runtime validation (zod, valibot, arktype).
- **OpenAPI** — type-only adapter from `openapi-typescript` output to misina's typed API.
- **Streaming** — built-in SSE and NDJSON helpers.
- **Subpath helpers**: `auth`, `cache`, `cookie`, `dedupe`, `paginate`, `stream`, `test`.

## Install

```sh
pnpm add misina
# or
npm install misina
# or
bun add misina
```

Requires Node ≥ 20.11. `AbortSignal.any` floor: Node 20.5+, Bun, Deno, modern browsers.

## Quick Start

```ts
import { createMisina } from "misina"

const api = createMisina({
  baseURL: "https://api.github.com",
  headers: { accept: "application/vnd.github+json" },
  timeout: 10_000,
  retry: 2,
})

// GET — typed
const user = await api.get<{ login: string }>("/users/octocat")
console.log(user.data.login, user.timings.total)

// POST with auto-JSON
await api.post("/repos/octocat/hello/issues", {
  title: "hi",
  body: "test",
})

// Error handling
import { isHTTPError } from "misina"
try {
  await api.get("/nope")
} catch (err) {
  if (isHTTPError(err)) console.log(err.status, err.data)
}
```

## API

### `createMisina(options?)`

```ts
import { createMisina } from "misina"

const api = createMisina({
  baseURL: "https://api.example.com", // optional
  allowAbsoluteUrls: true, // default
  headers: {
    /* ... */
  },
  timeout: 10_000, // per-attempt; false to disable
  totalTimeout: false, // wall-clock cap incl. retries
  signal: someAbortSignal, // user signal merged via AbortSignal.any
  retry: 2, // or full RetryOptions
  responseType: undefined, // 'json' | 'text' | 'arrayBuffer' | 'blob' | 'stream' | (auto)
  hooks: {
    /* ... */
  },
  driver: customDriver, // optional override (default: fetch driver)
  throwHttpErrors: true,
  validateResponse: undefined,
  parseJson: JSON.parse,
  stringifyJson: JSON.stringify,
  arrayFormat: "repeat", // 'brackets' | 'comma' | 'indices'
  paramsSerializer: undefined,
  redirect: "manual", // 'follow' | 'error'
  redirectSafeHeaders: undefined,
  redirectMaxCount: 5,
  redirectAllowDowngrade: false,
  cache: undefined, // standard fetch RequestCache
  credentials: undefined,
  next: undefined, // Next.js { revalidate, tags }
  defer: [], // late-binding callbacks
  onUploadProgress: undefined,
  onDownloadProgress: undefined,
})
```

Returns `Misina` with: `request`, `get`, `post`, `put`, `patch`, `delete`,
`head`, `options`, `extend`. All methods return a `MisinaResponsePromise<T>`.

### Hooks

```ts
const api = createMisina({
  hooks: {
    init: (options) => {
      // sync, mutates a per-request clone — runs BEFORE Request construction
      options.headers.authorization = `Bearer ${getToken()}`
    },
    beforeRequest: async (ctx) => {
      // can return a Request to replace, or a Response to skip the driver
    },
    beforeRetry: async (ctx) => {
      // ctx.error is set; refresh tokens, log, etc.
    },
    beforeRedirect: ({ request, sameOrigin }) => {
      // fired when redirect: 'manual' (default) follows a redirect
    },
    afterResponse: async (ctx) => {
      // can return a new Response to replace
    },
    beforeError: async (error, ctx) => {
      // must return an Error (transformed or original)
      return error
    },
  },
})
```

Hook errors are fatal — they don't trigger retry. Default and per-request
hooks concatenate (defaults run first).

### Retry

```ts
const api = createMisina({
  retry: {
    limit: 3,
    methods: ["GET", "PUT", "HEAD", "DELETE", "OPTIONS"],
    statusCodes: [408, 413, 429, 500, 502, 503, 504],
    afterStatusCodes: [413, 429, 503], // honor Retry-After / RateLimit-Reset
    maxRetryAfter: 60_000,
    delay: (attempt) => 0.3 * 2 ** (attempt - 1) * 1000,
    backoffLimit: 30_000,
    jitter: true,
    shouldRetry: ({ error }) => true, // ultimate escape hatch
    retryOnTimeout: true,
  },
})

// Shorthand: number → { limit }
createMisina({ retry: 5 })
// false → disabled
createMisina({ retry: false })
```

POST is **not retried** by default (idempotency).

### Errors

```ts
import {
  HTTPError,
  NetworkError,
  TimeoutError,
  isHTTPError,
  isNetworkError,
  isTimeoutError,
} from "misina"

try {
  await api.get("/x")
} catch (err) {
  if (isHTTPError(err)) {
    console.log(err.status, err.data, err.response)
  }
  if (isNetworkError(err)) console.log(err.cause)
  if (isTimeoutError(err)) console.log(err.timeout)
}
```

### Status-Based Catchers

```ts
const user = await api
  .get<User>("/users/42")
  .onError(404, () => null)
  .onError([401, 403], () => redirect("/login"))
  .onError("NetworkError", () => useCachedFallback())
```

### validateResponse

Treat `200 { ok: false }` as failure:

```ts
const api = createMisina({
  validateResponse: ({ data }) => (data as { ok: boolean }).ok === true,
})
```

Return an `Error` to throw a custom error directly.

### Custom JSON

```ts
createMisina({
  parseJson: (text) =>
    JSON.parse(text, (k, v) =>
      typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : v,
    ),
  stringifyJson: (value) =>
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
})
```

### .extend() and replaceOption

```ts
import { replaceOption } from "misina"

const authed = api.extend({ headers: { authorization: "Bearer x" } })

// Replace defaults' hooks instead of concatenating
const standalone = api.extend({
  hooks: replaceOption({ beforeRequest: [myHook] }),
})

// Function form sees parent defaults
const v2 = api.extend((parent) => ({
  baseURL: parent.baseURL?.replace("/v1", "/v2"),
}))
```

### Drivers

```ts
import { createMisina, defineDriver } from "misina"
import mockDriver from "misina/driver/mock"

const driver = defineDriver(() => ({
  name: "custom",
  request: async (req) => fetch(req),
}))()

createMisina({ driver })

// Mock for tests
const mock = mockDriver({ response: new Response(JSON.stringify({ ok: 1 })) })
const test = createMisina({ driver: mock })
```

## Subpaths

Each helper lives at `misina/<name>` so you only pay for what you import.

### misina/test

```ts
import { createTestMisina } from "misina/test"

const t = createTestMisina({
  routes: {
    "GET /users/:id": ({ params }) => ({ status: 200, body: { id: params.id } }),
    "POST /users": ({ request }) => ({ status: 201, body: { ok: true } }),
    "GET /flaky": () => ({ throw: "fetch failed" }), // simulate NetworkError
    "* /slow": () => ({ delay: 200, status: 200 }),
  },
})

await t.client.get("https://api.test/users/42")
expect(t.calls).toHaveLength(1)
expect(t.lastCall().method).toBe("GET")
```

### misina/auth

```ts
import { withBearer, withBasic, withRefreshOn401, withCsrf } from "misina/auth"

const api = withBearer(createMisina({ baseURL }), () => store.token)

const refreshed = withRefreshOn401(api, {
  refresh: async () => fetchNewToken(),
})

const django = withCsrf(api, { cookieName: "csrftoken", headerName: "X-CSRFToken" })
```

`withRefreshOn401` collapses concurrent 401s into a single in-flight refresh.

### misina/cookie

```ts
import { withCookieJar, MemoryCookieJar } from "misina/cookie"

const jar = new MemoryCookieJar()
const api = withCookieJar(createMisina({ baseURL }), jar)

await api.post("/login", { user, pass }) // Set-Cookie stored
await api.get("/profile") // Cookie sent automatically
```

### misina/cache

```ts
import { withCache, memoryStore } from "misina/cache"

const api = withCache(createMisina({ baseURL }), {
  store: memoryStore({ max: 500 }),
  ttl: 60_000,
  revalidate: true, // ETag / Last-Modified → 304 → reuse
})
```

### misina/dedupe

```ts
import { withDedupe } from "misina/dedupe"

const api = withDedupe(createMisina({ baseURL }))
// Concurrent identical GETs collapse onto one network request.
```

### misina/paginate

```ts
import { paginate, paginateAll } from "misina/paginate"

// Default: follow Link rel=next
for await (const user of paginate<User>(api, "/users")) {
  console.log(user.id)
}

// Cursor-based
const all = await paginateAll<Item>(api, "/items", {
  transform: (res) => res.data.items,
  next: (res) => (res.data.next ? { query: { cursor: res.data.next } } : false),
  countLimit: 1000,
})
```

### misina/stream

```ts
import { sseStream, ndjsonStream } from "misina/stream"

const res = await api.get("/events", { responseType: "stream" })
for await (const event of sseStream(res.raw)) {
  console.log(event.event, event.data)
}

const res2 = await api.get("/feed.ndjson", { responseType: "stream" })
for await (const item of ndjsonStream<Item>(res2.raw)) {
  console.log(item)
}
```

## Progress Events

```ts
await api.post("/upload", file, {
  onUploadProgress: ({ percent, bytesPerSecond }) => updateBar(percent),
})

await api.get("/download/big.bin", {
  responseType: "blob",
  onDownloadProgress: ({ loaded, total }) => updateBar(loaded / (total ?? 1)),
})
```

Upload progress streams the body in 64 KB chunks via `duplex: 'half'` on
runtimes that support it (Node 20+, Bun, Deno, Chrome 105+). On unsupported
runtimes the callback is silently skipped.

## defer — Late-Binding Config

```ts
const api = createMisina({
  defer: () => ({
    headers: { authorization: `Bearer ${currentToken()}` },
    next: { revalidate: 0 },
  }),
})
```

`defer` callbacks fire **after** init hooks, **before** beforeRequest hooks.

## Type-Safe Path Generics

```ts
import { createMisinaTyped } from "misina"

type Api = {
  "GET /users/:id": { params: { id: string }; response: User }
  "POST /users": { body: NewUser; response: User }
  "GET /users": { query: { page?: number }; response: User[] }
}

const api = createMisinaTyped<Api>({ baseURL: "https://api.example.com" })

const user = await api.get("/users/:id", { params: { id: "42" } })
//          ^? MisinaResponsePromise<User>
const created = await api.post("/users", { body: { name: "x" } })
const list = await api.get("/users", { query: { page: 2 } })
```

Path params are substituted at runtime: `/users/:id` → `/users/42` (also `{id}` syntax).

## OpenAPI

If you already run [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) on your spec, the type-only `misina/openapi` subpath turns its output into an `EndpointsMap` for free:

```ts
import { createMisinaTyped } from "misina"
import type { OpenApiEndpoints } from "misina/openapi"
import type { paths } from "./generated.d.ts"

const api = createMisinaTyped<OpenApiEndpoints<paths>>({ baseURL })

const user = await api.get("/users/{id}", { params: { id: "42" } })
//          ^? whatever paths['/users/{id}']['get']['responses']['200'] resolves to
```

For each path × verb in your spec, the adapter produces a `${VERB} ${path}` key with the right `params`, `query`, `body`, and `response` shapes pulled from `parameters.path`, `parameters.query`, `requestBody.content['application/json']`, and `responses[200|201|204|default].content['application/json']`. Operations that don't declare path/query/body simply omit those fields.

Zero runtime cost — the published `misina/openapi/index.mjs` is **11 bytes** (re-exports only). All the work happens in `.d.mts`.

## Standard Schema Validation

```ts
import { validated, validateSchema } from "misina"
import { z } from "zod"

const UserSchema = z.object({ id: z.string(), name: z.string() })

const user = await validated(api.get("/users/42"), UserSchema)
//                                                      ^? validated against zod
```

Throws `SchemaValidationError` with `.issues` on mismatch.

## Security Defaults

- Redirect mode `'manual'` by default — misina follows redirects itself.
- Cross-origin redirects strip `Authorization`, `Cookie`, `Proxy-Authorization`, `WWW-Authenticate`. Allowlist via `redirectSafeHeaders`.
- `https → http` redirects refused unless `redirectAllowDowngrade: true`.
- Header values containing CR/LF/NUL throw — request smuggling guard.

## Compared To

- **`ofetch`** — same shape, richer hooks, retry granularity (`Retry-After`, jitter), `NetworkError`-vs-`HTTPError` distinction, redirect security policy.
- **`ky`** — closest aesthetic neighbor. Adds driver pattern, cross-runtime cookie jar, pagination, status catchers, dedupe.
- **`axios`** — Fetch-first, ESM-only, no XHR fallback in core, no CommonJS dual-build pain. No interceptor mutation surprises.
- **`got`** — got is Node-only; misina runs everywhere. Pagination + cookie jar borrow got's design without the Node dependency tax.
- **`wretch`** — flat options object instead of chainable builder, but `.onError(404, ...)` borrows wretch's catcher ergonomics.

## License

MIT © productdevbook

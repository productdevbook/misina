<p align="center">
  <br>
  <img src="https://raw.githubusercontent.com/productdevbook/misina/main/.github/assets/cover.png" alt="misina — Driver-based, zero-dependency TypeScript HTTP client" width="100%">
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
  - [HTTP methods](#http-methods)
  - [Hooks](#hooks)
  - [Retry](#retry)
  - [Errors](#errors)
  - [Status-Based Catchers](#status-based-catchers)
  - [safe() — no-throw mode](#safe--no-throw-mode)
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
  - [misina/poll](#misinapoll)
  - [misina/stream](#misinastream)
  - [misina/breaker](#misinabreaker)
  - [misina/ratelimit](#misinaratelimit)
  - [misina/tracing](#misinatracing)
  - [misina/runtime/cloudflare](#misinaruntimecloudflare)
- [Idempotency-Key](#idempotency-key)
- [RFC 9457 problem+json](#rfc-9457-problemjson)
- [Fetch Priority](#fetch-priority)
- [Progress Events](#progress-events)
- [meta — per-request user data](#meta--per-request-user-data)
- [state — session-scoped mutable state](#state--session-scoped-mutable-state)
- [onComplete — terminal lifecycle hook](#oncomplete--terminal-lifecycle-hook)
- [trailingSlash + allowedProtocols](#trailingslash--allowedprotocols)
- [defer — Late-Binding Config](#defer--late-binding-config)
- [Type-Safe Path Generics](#type-safe-path-generics)
- [OpenAPI](#openapi)
- [Standard Schema Validation](#standard-schema-validation)
- [Security Defaults](#security-defaults)
- [Credits](#credits)

## Highlights

- **Zero deps** in the core. Optional peers only.
- **ESM-only**, tree-shakeable, sub-path exports for everything beyond the core.
- **Driver pattern** — swap the transport. Default driver wraps `globalThis.fetch`; ship a mock or your own.
- **Hooks lifecycle** — `init`, `beforeRequest`, `beforeRetry`, `beforeRedirect`, `afterResponse`, `beforeError`. Default + per-request hooks concatenate.
- **Retry** with `Retry-After` / `RateLimit-Reset` parsing, jitter, `backoffLimit`, custom `shouldRetry`. `NetworkError` retried independently from `HTTPError`.
- **Redirect policy** — RFC 9110 §15.4 compliant. Manual follow with cross-origin auth/cookie stripping by default. `https → http` downgrade refused.
- **`validateResponse`** — sync or async predicate sees status + parsed body, lets `200 { ok: false }` count as failure.
- **Standard Schema** support for runtime validation (zod, valibot, arktype).
- **OpenAPI** — type-only adapter from `openapi-typescript` output to misina's typed API.
- **Streaming** — built-in SSE (WHATWG HTML §9.2 compliant) and NDJSON helpers.
- **HTTP cache** — RFC 9111 compliant: `Cache-Control: no-store` / `max-age`, ETag / Last-Modified revalidation, `Vary` per-variant keying.
- **Cookie jar** — RFC 6265 compliant: domain match check, Path matching, Secure flag, Max-Age / Expires.
- **661 tests** across 90 files, exhaustively covering specs and edge cases.
- **Subpath helpers**: `auth`, `breaker`, `cache`, `cookie`, `dedupe`, `paginate`, `poll`, `ratelimit`, `stream`, `test`, `tracing`.
- **Idempotency-Key on retry** (RFC draft) — `idempotencyKey: 'auto'` sends a `crypto.randomUUID()` for retried mutations. No competitor ships this.
- **RFC 9457 problem+json** parsed onto `HTTPError.problem` automatically.
- **Circuit breaker** (`misina/breaker`) — Polly-shaped state machine, zero deps.
- **Polling helper** (`misina/poll`) — `until` predicate + interval + composed timeout/abort.
- **`safe()` mode** — Go-style `{ ok, data, error, response }` discriminated result, no throw.
- **`HTTPError<E>` typed error body**, `meta` + `state` for per-instance context, `onComplete` for unified observability.
- **HTTP `QUERY` method** (draft-ietf-httpbis-safe-method-w-body) shipped as `misina.query()`.
- **Opt-in decompression** (`decompress: true | string[]`) — gzip / deflate / br / zstd via `DecompressionStream`.
- **`bodyTimeout`** — independent cap on response-body read time for slow-streaming servers.
- **`maxResponseSize`** — byte cap with `Content-Length` fast-path + mid-stream counter; throws `ResponseTooLargeError`.
- **`requestId`** on `MisinaResponse` and `HTTPError` — auto-scanned from `x-request-id` / `request-id` / `x-correlation-id`. Surfaced in error message as `[req: <id>]`.
- **LLM SDK retry parity** — `retry-after-ms` (sub-second precision) + `x-should-retry` server hints honored by default.
- **`Server-Timing` parser** — `MisinaResponse.serverTimings` populated automatically.
- **W3C Trace Context** (`misina/tracing`) — `withTracing()` injects `traceparent` + `tracestate` + optional Baggage.
- **Rate-limit header parser** (`misina/ratelimit`) — handles OpenAI / Anthropic / IETF draft styles, normalizes reset values to `Date`.

## Install

```sh
pnpm add misina
# or
npm install misina
# or
bun add misina
```

Requires Node ≥ 22.11 / Bun ≥ 1.2 / Deno ≥ 2.0 / Baseline 2024 browsers (Safari 17.4+, Chrome 116+, Firefox 124+). Uses native `AbortSignal.any`, `AbortSignal.timeout`, and `Headers.getSetCookie()` — no polyfills.

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

// Error handling — classic try/catch
import { isHTTPError } from "misina"
try {
  await api.get("/nope")
} catch (err) {
  if (isHTTPError(err)) console.log(err.status, err.data)
}

// Error handling — Go-style, type-safe, no throw
const result = await api.safe.get<User, ApiError>("/users/42")
if (result.ok) {
  result.data // User
} else {
  result.error // HTTPError<ApiError> | NetworkError | TimeoutError
}
```

## API

### `createMisina(options?)`

```ts
import { createMisina } from "misina"

const api = createMisina({
  // URL resolution
  baseURL: "https://api.example.com",
  allowAbsoluteUrls: true, // reject if false + absolute URL given
  allowedProtocols: ["http", "https"], // add 'capacitor', 'tauri', etc.
  trailingSlash: "preserve", // 'strip' | 'forbid'

  // Headers + body + query
  headers: {
    /* ... */
  }, // Headers / [k,v][] / Record<string, string|undefined>
  arrayFormat: "repeat", // 'brackets' | 'comma' | 'indices'
  paramsSerializer: undefined,
  parseJson: JSON.parse,
  stringifyJson: JSON.stringify,

  // Lifecycle
  timeout: 10_000, // per-attempt; false to disable
  totalTimeout: false, // wall-clock cap incl. retries
  signal: someAbortSignal,
  retry: 2, // number | false | RetryOptions
  responseType: undefined, // 'json' | 'text' | 'arrayBuffer' | 'blob' | 'stream'

  // Hooks + drivers
  hooks: {
    /* init / beforeRequest / beforeRetry / beforeRedirect /
              afterResponse / beforeError / onComplete */
  },
  driver: customDriver, // default: fetch driver
  defer: [], // late-binding callbacks

  // Errors
  throwHttpErrors: true,
  validateResponse: undefined,

  // Redirect policy
  redirect: "manual", // 'follow' | 'error'
  redirectSafeHeaders: undefined, // headers to keep on cross-origin redirect
  redirectMaxCount: 5,
  redirectAllowDowngrade: false, // https → http allowed?

  // Modern features
  idempotencyKey: false, // 'auto' | string | (req) => string | false
  priority: undefined, // 'high' | 'low' | 'auto'
  meta: {
    /* per-request typed user data */
  },
  state: {
    /* session-scoped mutable state */
  },

  // Framework / runtime passthrough
  cache: undefined, // RequestCache
  credentials: undefined,
  next: undefined, // Next.js { revalidate, tags }

  // Progress
  onUploadProgress: undefined,
  onDownloadProgress: undefined,
  progressIntervalMs: 0, // throttle ms between callbacks
})
```

### HTTP methods

Returns `Misina` with: `request`, `get`, `post`, `put`, `patch`, `delete`,
`head`, `options`, `query` (HTTP QUERY method, draft-ietf-httpbis), `extend`,
plus `safe` for no-throw variants.

```ts
await api.get<User>("/users/42")
await api.post<User, ApiError>("/users", body)   // 2nd generic = error body type
await api.delete("/users/42")
await api.query("/search", { filter: { ... } })  // safe + idempotent verb with body
```

All methods return a `MisinaResponsePromise<T, E>`.

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
      // Can return a Request (override) or Response (short-circuit retries).
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
    onComplete: ({ request, response, error, durationMs, attempt }) => {
      // terminal-state hook — fires once per call after retries
      // single observation point for logging / metrics / tracing
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

#### Region failover (retry to a different host)

`beforeRetry` may return a `Request` to replace the URL on the next
attempt — useful for multi-region inference, alternative endpoints,
fallback DNS, etc. The `attempt` counter is 1-indexed for retries.

```ts
const REGIONS = [
  "https://us-east.example.com",
  "https://us-west.example.com",
  "https://eu.example.com",
]

createMisina({
  retry: { limit: 2, statusCodes: [502, 503, 504] },
  hooks: {
    beforeRetry: ({ request, attempt }) => {
      const next = REGIONS[attempt % REGIONS.length]
      const u = new URL(request.url)
      u.host = new URL(next).host
      return new Request(u.toString(), request)
    },
  },
})
```

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

### safe() — no-throw mode

For UI code where a `try/catch` widens the catch to `unknown`, use the
no-throw companion. Every shorthand mirrors onto `misina.safe`:

```ts
const result = await api.safe.get<User, ApiError>("/users/42")
if (result.ok) {
  result.data // User — type-safe
  result.response // MisinaResponse<User>
} else {
  result.error // HTTPError<ApiError> | NetworkError | TimeoutError
  result.response?.status // available on HTTPError; undefined on network errors
}
```

The discriminated `{ ok, data, error, response }` union makes both branches
type-safe at the call site — no `try/catch` plumbing needed.

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

### misina/poll

Long-poll a URL until a predicate is satisfied. Composes external + timeout
signals via `AbortSignal.any`.

```ts
import { poll, PollExhaustedError } from "misina/poll"

const job = await poll<JobStatus>(misina, "/jobs/42", {
  interval: 1000,                         // ms — or fn(attempt) => ms
  timeout: 60_000,                        // total deadline (TimeoutError on exceed)
  maxAttempts: 30,                        // throws PollExhaustedError when reached
  signal: external,                       // composes with timeout
  until: (job) => job.state === "done",
  init: { headers: { ... } },             // forwarded to misina.get
})
```

`followAccepted` covers the common 202 + Location async-job pattern:

```ts
import { followAccepted } from "misina/poll"

const result = await followAccepted<JobResult>(misina, {
  trigger: () => misina.post("/jobs", body), // returns 202 + Location
  interval: 2000,
  timeout: 5 * 60_000,
  until: (data) => data.status === "completed",
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

LLM tool-call accumulators ship from the same subpath:

```ts
import { accumulateAnthropicMessage, accumulateOpenAIToolCalls, collect } from "misina/stream"

// OpenAI: drains the SSE stream and merges delta.tool_calls[] indexed
// by `index`; stops at [DONE].
const calls = await accumulateOpenAIToolCalls(sseStream(res.raw))

// Anthropic: drains a Messages stream (named events) and assembles
// the final message with text + tool_use blocks.
const message = await accumulateAnthropicMessage(sseStream(res.raw))

// Generic Array.reduce for async iterables — building block.
const total = await collect(sseStream(res.raw), (n) => n + 1, 0)
```

Streams (and `paginate`, `poll`) implement `[Symbol.asyncDispose]` so
TC39 explicit resource management works:

```ts
{
  await using stream = sseStream(res.raw)
  for await (const ev of stream) {
    /* ... */
  }
} // stream auto-aborted on scope exit
```

### misina/breaker

Polly / cockatiel-shaped circuit breaker. State machine:

```
closed ──[N failures within windowMs]──▶ open
open   ──[wait halfOpenAfter]──▶ half-open  (one probe allowed)
half-open ──[probe ok]──▶ closed
half-open ──[probe fails]──▶ open  (fresh timer)
```

```ts
import { withCircuitBreaker, CircuitOpenError } from "misina/breaker"

const api = withCircuitBreaker(misina, {
  failureThreshold: 5, // trip after 5 failures
  windowMs: 30_000, // sliding window
  halfOpenAfter: 10_000, // ms before letting one probe through
  // isFailure defaults to: any thrown error or 5xx HTTPError.
  // 4xx is intentionally NOT counted (client mistake, not service degradation).
})

try {
  await api.get("/users/42")
} catch (err) {
  if (err instanceof CircuitOpenError) {
    console.log("upstream cooked — retry in", err.retryAfter, "ms")
  }
}

// Inspect / control the breaker:
api.breaker.state() // 'closed' | 'open' | 'half-open'
api.breaker.trip() // force open (e.g. external monitoring signal)
api.breaker.reset() // force closed
```

No major fetch client (ofetch, ky, axios, got, wretch) ships a built-in
breaker — users had to wrap with `cockatiel`/`opossum`. This subpath fits
naturally with misina's driver pattern and adds zero deps.

### misina/ratelimit

Parser for `x-ratelimit-*` headers + an in-process token bucket.

```ts
import { parseRateLimitHeaders, withRateLimit } from "misina/ratelimit"

// Read what the server says.
const info = parseRateLimitHeaders(response.headers)
console.log(info?.requests?.remaining, info?.tokens?.remaining)

// Or wire a client-side limiter that gates dispatch and learns from
// the response headers automatically:
const api = withRateLimit(createMisina({ baseURL }), {
  rpm: 500,
  tpm: 100_000,
  estimateTokens: (req) => approximateInputTokens(req),
})
```

`withRateLimit` acquires from both buckets in `beforeRequest`, snaps
the buckets to the server's `x-ratelimit-remaining-*` numbers in
`onComplete`, and parks both until `resetAt` on a 429. AbortSignal
cancels a queued acquire.

Reset values normalize to `Date`: ISO 8601, Unix seconds (absolute or
seconds-from-now via 100k threshold), and duration suffix (`'500ms'`,
`'30s'`, `'1m30s'`, `'2h15m'`).

### misina/tracing

W3C Trace Context propagator. Auto-injects `traceparent` and forwards
`tracestate` on every outgoing request. Optional W3C Baggage header.

```ts
import { withTracing } from "misina/tracing"

const api = withTracing(createMisina({ baseURL }))
// Each request gets a fresh `traceparent: 00-<32hex>-<16hex>-01`.

// Compose with OpenTelemetry by reading the active span:
import { trace } from "@opentelemetry/api"

const apiOtel = withTracing(createMisina({ baseURL }), {
  getCurrentSpan: () => {
    const span = trace.getActiveSpan()
    if (!span) return null
    const ctx = span.spanContext()
    return { traceId: ctx.traceId, parentId: ctx.spanId, flags: ctx.traceFlags }
  },
  baggage: { tenant: "acme", env: "prod" },
})
```

Caller-supplied `traceparent` / `Baggage` headers are preserved (no
overwrite). Each request gets a new parent-id; each Baggage callback is
evaluated per-request when supplied as a function.

### misina/runtime/cloudflare

Type-only augmentation for Cloudflare Workers. Importing the module
narrows `MisinaOptions.cf` to the documented `cf` property bag
(`cacheTtl`, `cacheKey`, `cacheEverything`, `polish`, `image`, etc.).
The value is forwarded opaquely to the underlying `fetch` so workerd
acts on it.

```ts
import "misina/runtime/cloudflare"

await api.get("/asset", { cf: { cacheTtl: 86_400, cacheEverything: true } })
```

Same augmentation surface (`MisinaRuntimeOptions`) is reserved for
future `runtime/bun` and `runtime/deno` subpaths.

## Server-Timing

Every `MisinaResponse` carries a parsed `serverTimings` array (W3C
Server-Timing). Empty when the header is absent.

```ts
const r = await api.get("/")
for (const t of r.serverTimings) {
  console.log(t.name, t.dur, t.desc)
}

// Or parse from any Headers manually:
import { parseServerTiming } from "misina"
const entries = parseServerTiming(headers.get("server-timing"))
```

## Idempotency-Key

Auto-generate `Idempotency-Key` on retried mutations so the server can
deduplicate. Per [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).

```ts
const api = createMisina({
  idempotencyKey: "auto", // crypto.randomUUID() per logical call
  retry: { limit: 3, methods: ["POST"] },
})

await api.post("/charges", { amount: 100 })
// First attempt → Idempotency-Key: 9b1d…
// All retries → same key. Server safely deduplicates the side-effect.
```

`'auto'` only fires for non-idempotent methods (POST/PATCH/DELETE) when
`retry > 0`. GET/HEAD/OPTIONS/PUT skip it (already idempotent by spec).
A user-supplied `Idempotency-Key` header always wins.

```ts
// String form — useful for an externally-supplied id (Stripe-style):
createMisina({ idempotencyKey: requestId })

// Function form — runs once per logical request, not per attempt:
createMisina({ idempotencyKey: (req) => `order-${orderId}` })

// Disabled (default):
createMisina({ idempotencyKey: false })
```

No competing client ships this today.

## RFC 9457 problem+json

Servers signal application errors with `Content-Type: application/problem+json`
([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html), formerly RFC 7807).
Misina lifts the structured shape onto `HTTPError.problem` automatically.

```ts
try {
  await api.post("/charge", { amount: 100 })
} catch (err) {
  if (isHTTPError(err) && err.problem) {
    console.log(err.problem.type) // URI ref to the problem type
    console.log(err.problem.title) // short summary
    console.log(err.problem.status) // echoed status
    console.log(err.problem.detail) // specific occurrence
    console.log(err.problem.instance) // URI ref to this occurrence
    console.log(err.problem.balance) // extension fields preserved
  }
}
```

The default `error.message` includes `problem.detail` (or title fallback)
so console output is immediately useful:

```
HTTPError: Request failed with status 402: Your account balance is $0.00.
```

## Fetch Priority

Pass-through for [`RequestInit.priority`](https://web.dev/articles/fetch-priority)
— hint to the browser/runtime about the urgency of a request.

```ts
await api.get("/critical", { priority: "high" })
await api.get("/prefetch", { priority: "low" })
```

Honored by Chromium browsers, Firefox 132+, Safari 17.4+, and Cloudflare
Workers — completes the Baseline 2024 set.

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
runtimes that support it (Node 22+, Bun, Deno, Chrome 105+). Safari and
Firefox don't support streaming request bodies yet — on those, the
callback is silently skipped and the body is sent in one go.

Throttle high-frequency callbacks via `progressIntervalMs`:

```ts
createMisina({
  onUploadProgress: ({ percent }) => updateBar(percent),
  progressIntervalMs: 100, // fire at most once per 100ms
})
```

The final 100% event always fires regardless of throttle.

## meta — per-request user data

Per-request data that flows through every hook on `ctx.options.meta`. Type
via module augmentation (TanStack Query pattern):

```ts
declare module "misina" {
  interface MisinaMeta {
    tag?: string
    tenant?: string
    requestId?: string
  }
}

const api = createMisina({
  hooks: {
    onComplete: ({ options, durationMs }) => {
      tracer.send({ tag: options.meta?.tag, durationMs })
    },
  },
})

await api.get("/users/42", { meta: { tag: "search", tenant: "acme" } })
```

`.extend()` shallow-merges meta (child keys win, parent keys preserved).

## state — session-scoped mutable state

Same idea as `meta`, but for **shared, mutable** state across every call on
one instance. Hooks read AND write `ctx.options.state`:

```ts
declare module "misina" {
  interface MisinaState {
    token?: string
    requestCount?: number
  }
}

const session = createMisina({
  state: { token: "v1", requestCount: 0 },
  hooks: {
    beforeRequest: (ctx) => {
      ctx.options.state.requestCount! += 1
      const headers = new Headers(ctx.request.headers)
      if (ctx.options.state.token) headers.set("authorization", `Bearer ${ctx.options.state.token}`)
      return new Request(ctx.request, { headers })
    },
  },
})

// Later, from anywhere — token rotation reaches subsequent calls:
// session.state.token = "v2"  // (via a hook or external refresher)
```

Same reference shared across calls on one instance. `.extend()` deliberately
gives the child a fresh state object so mutations don't leak across boundaries.

## onComplete — terminal lifecycle hook

Fires exactly once per logical call after retries + redirects, with either
`response` or `error` populated. Single observation point for logging,
metrics, and distributed tracing:

```ts
createMisina({
  hooks: {
    onComplete: ({ request, response, error, durationMs, attempt, options }) => {
      log({
        url: request.url,
        status: response?.status,
        error: error?.name,
        durationMs,
        attempts: attempt + 1,
        tag: options.meta?.tag,
      })
    },
  },
})
```

Covers success, `HTTPError`, `NetworkError`, `TimeoutError` paths uniformly —
no need to wire `afterResponse` and `beforeError` separately.

## trailingSlash + allowedProtocols

URL guardrails for backends that canonicalize paths or for embedded runtimes
with custom schemes:

```ts
createMisina({
  trailingSlash: "strip", // 'preserve' (default) | 'strip' | 'forbid'
  allowedProtocols: ["http", "https", "capacitor"], // default ['http','https']
})

// 'strip' → /users/  becomes /users
// 'forbid' → throws a clear Error if path ends with /
// allowedProtocols rejects ftp://, file://, javascript:, etc by default.
```

Both check the URL after `baseURL` resolution, before dispatch.

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

For one-off URL building outside the typed client, use `path()`:

```ts
import { path } from "misina"

path("/users/:id/posts/:postId", { id: "42", postId: "7" })
// → "/users/42/posts/7"
```

`path()` (and `createMisinaTyped`) reject values that would escape the
template — `..`, `/`, `\`, NUL, CR/LF.

## File uploads — `toFile()`

Build a `File` from any byte-bearing source (string, Uint8Array,
ArrayBuffer, Blob, ReadableStream, async iterable). Useful for
multipart uploads to LLM vision / audio / files endpoints.

```ts
import { toFile } from "misina"

const fd = new FormData()
fd.append("file", await toFile("image.jpg", readableStream, { type: "image/jpeg" }))
await api.post("/vision", fd)
```

The body serializer also auto-wraps **async iterables** with
`ReadableStream.from(...)` — async generators or Node `Readable`
streams can be passed as `body` directly.

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
- URL composition (baseURL + path) rejects raw CR/LF/NUL.
- Path params in `createMisinaTyped` reject `..`, `/`, `\`, NUL (traversal guard).
- Cross-origin redirects strip `Authorization`, `Cookie`, `Proxy-Authorization`, `WWW-Authenticate`, `Signature`, `Signature-Input`. Configurable via `redirectStripHeaders`.
- `https → http` redirects refused unless `redirectAllowDowngrade: true`.
- `maxResponseSize` byte cap with pre-stream Content-Length check + mid-stream byte counter.
- `allowAbsoluteUrls: false` also rejects scheme-relative URLs (`//other.com/x`).

## Credits

misina stands on the shoulders of the modern fetch ecosystem. The design
borrows liberally from prior art — credit where it's due:

- **[ofetch](https://github.com/unjs/ofetch)** (unjs) — defer pattern, hook surface shape.
- **[ky](https://github.com/sindresorhus/ky)** (Sindre Sorhus) — `.extend()` ergonomics, `beforeRetry` returning a `Response`, response timeout semantics, `parseJson(text, ctx)` (PR #849).
- **[axios](https://github.com/axios/axios)** — request/response interceptor concept; `paramsSerializer` and the option-bag API surface.
- **[got](https://github.com/sindresorhus/got)** — pagination iterator design, cookie-jar interface contract.
- **[wretch](https://github.com/elbywan/wretch)** — `.onError(404, fn)` status catcher ergonomics.
- **[openapi-fetch / openapi-typescript](https://openapi-ts.dev/)** (drwpow) — the `Paths` shape that the `misina/openapi` adapter targets.
- **[cockatiel](https://github.com/connor4312/cockatiel)** (connor4312) and **Microsoft Polly** — circuit-breaker state-machine shape used in `misina/breaker`.
- **[Standard Schema](https://standardschema.dev)** (zod / valibot / arktype authors) — the `~standard.validate` contract.
- **[unstorage](https://github.com/unjs/unstorage)** and **[unemail](https://github.com/productdevbook/unemail)** — the `defineDriver()` pattern.

Specs and standards consulted along the way:

- **WHATWG Fetch** + **AbortSignal** + **HTML §9.2 (EventStream)**
- **RFC 9110** (HTTP semantics, redirects)
- **RFC 9111** (HTTP caching)
- **RFC 8288** (Link header)
- **RFC 6265** (Cookies)
- **RFC 9457** (Problem details for HTTP APIs)
- **draft-ietf-httpapi-idempotency-key-header**

Built by **[productdevbook](https://github.com/productdevbook)** and
**[Claude Code](https://claude.com/claude-code)** — 59+ audit passes, 481
regression tests, zero deps.

## License

MIT © [productdevbook](https://github.com/productdevbook)

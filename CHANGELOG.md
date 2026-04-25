# Changelog

All notable changes to misina are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Hardening — post-v0.1 audit (still in [Unreleased])

37 consecutive audit passes against WHATWG Fetch / AbortSignal / HTML
EventStream, RFC 9110 / 9111 / 8288 / 6265, and the latest merged PRs in
ofetch, ky, and axios. Every pass added regression tests; total test
count climbed from 18 → 359 across 49 files.

Recent passes (38-44) — modernization + new features:

- **Runtime baseline raised** to Node ≥ 22.11 / Bun ≥ 1.2 / Deno ≥ 2.0 /
  Baseline 2024 browsers. Node 20 EOL'd April 2026. Native
  `AbortSignal.any`, `AbortSignal.timeout`, `Headers.getSetCookie()` —
  no polyfills. `_signal.mjs` shrunk by 58%.
- **UTF-8 safe Basic auth** — `withBasic` now correctly encodes
  non-Latin1 credentials (Turkish ş/ı/ç, etc).
- **`idempotencyKey: 'auto'`** — sets `crypto.randomUUID()` as the
  `Idempotency-Key` on retried POST/PATCH/DELETE so servers can
  deduplicate. The key pins to the original request and stays
  identical across attempts. Per draft-ietf-httpapi-idempotency-key.
- **RFC 9457 problem+json on `HTTPError`** — `application/problem+json`
  is parsed and surfaced as `err.problem: { type, title, status, detail,
  instance, ...extensions }`. The default error message now includes
  `problem.detail` for immediate console legibility.
- **`beforeRetry` may return a `Response`** — ky-style. Synthesize a
  fallback / cached response and skip the retry network call entirely.
- **`priority` passthrough** — `'high' | 'low' | 'auto'` forwarded to
  the underlying `fetch()`.
- **Circuit breaker subpath** `misina/breaker` — Polly/cockatiel
  state machine (closed → open → half-open → closed), no runtime dep.

Recent passes (22-37):

- **Pre-flight + retry-loop abort checks** — an already-aborted user
  signal now rejects before any driver call. Late aborts during retry
  waiting cancel the loop instead of starting a fresh attempt.
- **mergeHeaders accepts Headers / [k,v][] / undefined values** —
  fixed a hard crash when a Headers instance, tuple-array, or
  `{ auth: token ?? undefined }` (typical optional-header pattern)
  was passed in.
- **Stream cancel propagation** — `linesOf()` now cancels through the
  reader so the cancel signal traverses pipeThrough(TextDecoderStream)
  back to the source body. Previously, early break-out of an SSE/NDJSON
  iterator leaked the upstream connection in Node 22+.
- **HTTPError body parse tolerance** — a 500 with malformed JSON now
  surfaces as `HTTPError(status=500, data=<text>)` instead of a
  buried `SyntaxError`.
- **dedupe slot leak** — sequential awaited calls (`await m.get(); await m.get()`)
  no longer collapse onto the first call's response. Removed the
  unnecessary `queueMicrotask` cleanup buffer.
- **MisinaOptions.headers widened** to `HeadersInit | Record<string, string | undefined>`
  — DX win, callers can pass Headers instances, tuple arrays, or
  drop optional headers without type casts.
- **SchemaValidationError.message** now includes the first issue's
  message and path. The full `issues` array remains attached.

Older passes (1-21) include:

- **Retry-After parsing**: empty / malformed token no longer produces a
  zero-second instant retry.
- **TimeoutError.timeout**: now reflects the configured timeout, not 0.
- **HTTPError.data on retry**: parsed body is now available on
  \`ctx.error.data\` inside \`shouldRetry\`.
- **Body re-use across retries**: the runtime now snapshots the original
  Request and clones it per attempt — so even \`ReadableStream\` bodies
  retry without an explicit \`beforeRetry\` reassignment.
- **303 / 301 / 302 demote**: drops \`content-type\` and \`content-length\`
  headers when downgrading to GET.
- **Smuggling guard for defer**: defer-supplied headers go through the
  CR/LF/NUL validator.
- **case-insensitive \`.extend()\` headers merge**: \`Authorization\` vs
  \`authorization\` no longer produce duplicate keys.
- **withRefreshOn401 recursion**: refreshed-then-401 no longer loops
  forever; marker tracked in-process via \`WeakSet<Response>\`.
- **paginate cycle detection**: a self-pointing \`next\` no longer hangs.
- **Link header parser**: handles URLs with commas, multi-link headers,
  space-separated rel values (RFC 8288 §3).
- **cache RFC 9111**: honors \`Cache-Control: no-store\` and \`max-age\`,
  and stores \`Vary\` variants under per-variant keys (Accept-Language en
  vs tr no longer clobber each other).
- **cookie RFC 6265 §5.3**: rejects \`Set-Cookie\` with a \`Domain\`
  attribute that doesn't domain-match the request URL's host.
- **SSE WHATWG HTML §9.2**: BOM stripping, empty event reset to
  'message', NUL in id ignored, retry digit-only.
- **withDedupe**: now actually deduplicates POST/PUT/PATCH/DELETE when
  opted in via the \`methods\` option (the spread was reusing the
  underlying instance's mutating methods).
- **stream body retry**: \`Request.clone()\` tees the underlying body, so
  streamed retries work automatically without explicit reassignment.
- **createMisinaTyped init optional**: endpoints with no required
  fields no longer demand a second \`{}\` argument.

### Added — v0.1.0

Initial release. Driver-based, zero-dependency, fetch-first TypeScript
HTTP client.

#### Core

- `createMisina(options)` factory returning a typed `Misina` instance.
- `request` / `get` / `post` / `put` / `patch` / `delete` / `head` / `options` shorthands.
- `MisinaResponse<T>` with `data`, `status`, `statusText`, `headers`, `url`, `type`, `timings`, and `raw` Response.
- WHATWG URL resolution against `baseURL` — never string-concat (closes the SSRF prefix attack class).
- `allowAbsoluteUrls` flag for confining requests to `baseURL`'s origin.
- Auto JSON serialization of plain-object request bodies; pass-through for `FormData` / `Blob` / `URLSearchParams` / streams / `ArrayBuffer`.
- Auto JSON parsing for `application/json` and `application/*+json` responses; stream / text / blob / arrayBuffer response types.
- Empty-body response detection: `HEAD`, `204` / `304` / `1xx`, `content-length: 0`, opaque CORS responses → `data: undefined` instead of `JSON.parse('')`.

#### Driver pattern (#12)

- `defineDriver()` factory and `MisinaDriver` interface.
- Default driver at `misina/driver/fetch` wraps `globalThis.fetch`.
- Mock driver at `misina/driver/mock` for testing.

#### Hooks lifecycle (#1, #18)

- `init` — sync, mutates a per-request cloned options object before `Request` is built.
- `beforeRequest` — async, may return a `Request` (replace) or `Response` (skip driver).
- `beforeRetry` — async, fires before each retry attempt with `ctx.error` set.
- `beforeRedirect` — fires when redirect mode is `'manual'` (default) and a 3xx is followed.
- `afterResponse` — async, may return a new `Response` to replace.
- `beforeError` — async, returns the final `Error` (transformed or original).
- Hook errors are fatal (no silent retry).
- Default + per-request hooks concatenate (defaults run first).

#### Retry (#2)

- `retry: number | boolean | RetryOptions`.
- `Retry-After` and `RateLimit-Reset` header parsing with `maxRetryAfter` cap.
- Configurable `methods`, `statusCodes`, `afterStatusCodes`, `delay`, `backoffLimit`, `jitter`, `shouldRetry`.
- `NetworkError` retried independently from `HTTPError`; POST not retried by default.
- `retryOnTimeout` flag.

#### Timeout & abort (#8)

- Per-attempt `timeout` (default 10s, `false` to disable).
- `totalTimeout` wall-clock cap across all attempts including retry delays.
- User `signal` merged with timeout via `AbortSignal.any` (Node 20.5+ floor); fallback for older runtimes.
- `TimeoutError` mapping distinct from `NetworkError`.

#### Errors (#4)

- Class hierarchy: `MisinaError` → `HTTPError<T>`, `NetworkError`, `TimeoutError`.
- `HTTPError.data` carries the parsed response body.
- Type guards: `isMisinaError`, `isHTTPError`, `isNetworkError`, `isTimeoutError`.
- Stack capture at the `MisinaError` constructor call site.

#### Redirect policy (#19)

- `redirect: 'manual' | 'follow' | 'error'`. `'manual'` (default) follows redirects in misina with header policy applied.
- Cross-origin redirects strip `Authorization`, `Cookie`, `Proxy-Authorization`, `WWW-Authenticate`. Allowlist via `redirectSafeHeaders`.
- `https → http` downgrade refused unless `redirectAllowDowngrade: true`.
- `redirectMaxCount` cap (default 5).
- 303 demotes to GET; 301/302 on POST/PUT/PATCH demoted to GET (matches browser behavior).

#### Validation & error sugar (#22, #31)

- `validateResponse({ status, headers, data, response })` predicate; return `false`, an `Error` instance, or `true`. Lets `200 { ok: false }` count as failure.
- `throwHttpErrors` boolean shortcut.
- `.onError(matcher, handler)` extension on `MisinaResponsePromise`. Matcher: status code, array of statuses, error class name, or predicate.

#### Body & query (#11, #28)

- `parseJson` / `stringifyJson` overrides (BigInt, Date reviver, custom dialects).
- `arrayFormat`: `'repeat'` (default) | `'brackets'` | `'comma'` | `'indices'`.
- `paramsSerializer` full override.
- `query` accepts `Record`, `URLSearchParams`, or `string`.

#### Header smuggling guard (#10)

- Header names and values containing CR / LF / NUL throw at the merge boundary.

#### `.extend()` (#6)

- Deep-merge defaults: headers shallow-merge, hooks arrays concat, primitives child-wins.
- `replaceOption(value)` Symbol-tagged sentinel forces replace.
- Function form `parent.extend((p) => ({ ... }))` reads parent state.

#### Observability (#25)

- Every `MisinaResponse` carries `timings: { start, responseStart, end, total }` from `performance.now()`.

#### Framework passthrough (#26)

- `cache: RequestCache` and `next: { revalidate, tags }` pass through to the underlying fetch.
- `credentials` only forwarded when explicitly set (Cloudflare Workers compat).

#### Progress (#5)

- `onUploadProgress`: chunked write (64 KB) via `duplex: 'half'` on supported runtimes; gracefully no-op on unsupported.
- `onDownloadProgress`: wraps `Response.body` in a tee'd `ReadableStream`.
- Progress event shape: `{ loaded, total, percent, bytesPerSecond }`.

#### `defer` (#24)

- `defer: MaybeArray<DeferCallback>` runs after `init` hooks, before `beforeRequest`. Returns a partial options patch.

#### Subpath helpers

- **`misina/test`** (#16) — `createTestMisina` with `METHOD /path/:param` route matching, latency simulation, network-error simulation, call recorder.
- **`misina/auth`** (#15) — `withBearer`, `withBasic`, `withRefreshOn401` (single in-flight refresh), `withCsrf`.
- **`misina/cookie`** (#21) — `MemoryCookieJar` (zero-dep) implementing `CookieJar` interface; `withCookieJar` reads `Set-Cookie` and echoes `Cookie` per URL with same-origin / Secure / Domain / Path / Expires honored.
- **`misina/cache`** (#14) — `withCache` + `memoryStore`; ETag / Last-Modified revalidation; TTL.
- **`misina/dedupe`** (#23) — `withDedupe` collapses concurrent identical safe-method requests.
- **`misina/paginate`** (#20) — `paginate(misina, url, opts)` async iterator; default follows `Link: rel="next"`; `transform` / `filter` / `next` / `countLimit` / `requestLimit`. `paginateAll()` materializer.
- **`misina/stream`** (#7) — `sseStream(response)`, `ndjsonStream<T>(response)`, `linesOf(response)`. Iterator close cancels the underlying stream.

#### Type-safe API (#3)

- `createMisinaTyped<EndpointsMap>()` — IntelliSense on path, params, query, body, response.
- Path parameter substitution: `/users/:id` → `/users/42` (also `{id}` syntax).
- `StandardSchemaV1` type + `validateSchema` / `validated` helpers for runtime validation (zod, valibot, arktype).
- `SchemaValidationError` + `isSchemaValidationError`.

#### OpenAPI (#35)

- `misina/openapi` subpath — type-only adapter `OpenApiEndpoints<Paths>` that converts an [`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript)-shaped `paths` type into misina's `EndpointsMap`.
- Picks up `parameters.path`, `parameters.query`, `requestBody.content['application/json']`, and `responses[200|201|204|default].content['application/json']` per operation.
- Zero runtime cost — published `.mjs` is 11 bytes (re-exports only); all the logic is in `.d.mts`.
- Structurally matches the openapi-typescript output shape — works with any generator that emits the same shape.

#### Quality

- 394 tests passing across 54 files.
- Lint clean (oxlint + oxfmt), typecheck clean (`tsgo --noEmit` with `--isolatedDeclarations`).
- Bundle budget gate: core public surface 418 B, engine 12 KB, every subpath ≤ 6 KB.
- CI matrix: Node 20 / 22 / 24, Bun, Deno smoke test.
- Cross-runtime targets: Node ≥ 20.11, Bun, Deno, Cloudflare Workers, modern browsers.

[Unreleased]: https://github.com/productdevbook/misina/commits/main

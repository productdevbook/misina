# Changelog

All notable changes to misina are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

#### Quality

- 68 tests passing across 9 files.
- Lint clean (oxlint + oxfmt), typecheck clean (`tsgo --noEmit` with `--isolatedDeclarations`).
- Bundle budget gate: core public surface 418 B, engine 12 KB, every subpath ≤ 6 KB.
- CI matrix: Node 20 / 22 / 24, Bun, Deno smoke test.
- Cross-runtime targets: Node ≥ 20.11, Bun, Deno, Cloudflare Workers, modern browsers.

[Unreleased]: https://github.com/productdevbook/misina/commits/main

# misina — agents guide

Driver-based, zero-dependency, fetch-first TypeScript HTTP client. Hooks
lifecycle, retry, error taxonomy, and the Web Fetch API as the canonical
wire format.

This file is for coding agents (Claude Code, Cursor, etc.). Read it before
making changes.

## Architectural commitments (locked)

1. **Fetch-first.** Drivers consume a real `Request` and return a real `Response`.
2. **ESM-only.** No CJS, no UMD. Match `unemail`/`sumak`.
3. **Zero core deps.** Subpath plugins may declare peer dependencies.
4. **Modern runtime baseline.** Node ≥ 22.11, Bun ≥ 1.2, Deno ≥ 2.0, Baseline 2024 browsers. Use native `AbortSignal.any`, `AbortSignal.timeout`, `Headers.getSetCookie()`, `Promise.withResolvers()` directly — no polyfills, no feature checks unless the API is V8-specific (e.g. `Error.captureStackTrace`).
5. **Hooks > interceptors.** Per-phase typed context, array-merging, fatal error rule.
6. **NetworkError vs HTTPError** are distinct classes.
7. **Promise-only API.** No dual Promise/Stream surface.
8. **Manual redirect handling** by default — to enable cross-origin header policy.

## Repo layout

```
src/
  index.ts             — public exports
  misina.ts            — createMisina + lifecycle orchestrator
  types.ts             — all public types
  typed.ts             — createMisinaTyped + Standard Schema
  _body.ts             — body serialization, response parsing
  _catch.ts            — .onError(matcher, handler) extension
  _hooks.ts            — hook merging
  _merge.ts            — deep-merge for .extend() + replaceOption
  _progress.ts         — upload/download progress streams
  _redirect.ts         — manual redirect loop, header policy
  _retry.ts            — retry math, Retry-After parsing
  _signal.ts           — AbortSignal.any / AbortSignal.timeout
  _url.ts              — WHATWG URL resolve, query serialization
  driver/
    _define.ts         — defineDriver factory
    fetch.ts           — default driver (globalThis.fetch)
    mock.ts            — testing driver
  errors/              — MisinaError / HTTPError / NetworkError / TimeoutError
  stream/              — SSE, NDJSON
  paginate/            — Link-header pagination
  dedupe/              — dedupe plugin
  cache/               — cache plugin + memoryStore
  auth/                — bearer / basic / refreshOn401 / csrf plugins
  auth/oauth           — OAuth 2.0 client-credentials / refresh-token plugin
  auth/sigv4           — AWS SigV4 request signing plugin
  auth/signed          — generic HMAC request signing
  cookie/              — MemoryCookieJar + cookieJar plugin
  breaker/             — circuit breaker plugin
  ratelimit/           — client-side rate limit plugin
  tracing/             — W3C traceparent / tracestate propagation
  poll/                — polling helper
  digest/              — Digest auth + Content-Digest helpers
  transfer/            — chunked upload/download helpers
  hedge/               — request hedging plugin
  beacon/              — sendBeacon-style fire-and-forget
  graphql/             — typed GraphQL client
  openapi/             — OpenAPI typed client generator
  otel/                — OpenTelemetry bridge
  sentry/              — Sentry breadcrumb / error bridge
  runtime/bun          — Bun-specific helpers
  runtime/cloudflare   — Cloudflare Workers helpers
  runtime/deno         — Deno helpers
  runtime/next         — Next.js helpers
  test/                — createTestMisina (route matching, recorder)
test/                  — vitest suites
```

## Coding rules

- **No comments unless the WHY is non-obvious.** Don't restate what the code does.
- **No backwards-compat shims.** No `// removed` markers, no deprecated re-exports.
- **No defensive validation** for things internal callers can't violate.
- **Trust the runtime.** Don't polyfill `AbortSignal.any`/`Response`/`Request`.
- **Drivers return `Response`.** Never replace this contract.
- **Hooks errors are fatal.** Don't try-catch around hooks to swallow.

## Test discipline

- Every public feature has at least one test in `test/<feature>.test.ts`.
- Mock driver via `mockDriverFactory({ response | handler })` for happy-path tests.
- `createTestMisina` for route-matching tests with assertion on calls.
- Network-style errors thrown in custom drivers: throw `TypeError("fetch failed")`
  to trip the `NetworkError` mapper.

## Build pipeline

- `pnpm test` → lint + typecheck + vitest
- `pnpm build` → obuild → `dist/` (.mjs + .d.mts)
- `pnpm fmt` → oxfmt rewrite (run before commit)
- TypeScript: `--isolatedDeclarations` enabled — every export needs an
  explicit type annotation. Default exports must be assigned to a typed const
  first, then re-exported.

## Subpath conventions

Each subpath under `src/<name>/index.ts` should:

- Be a single file (or a folder if it grows).
- Be referenced in `package.json#exports` as `./<name>` → `./dist/<name>/index.{mjs,d.mts}`.
- Export plugin **factories** that return a `MisinaPlugin` and are dropped into
  `createMisina({ use: [...] })`. Plugins contribute `hooks` and optionally an
  `extend` slot that augments the returned client's typed surface.

  ```ts
  import { createMisina } from "misina"
  import { bearer } from "misina/auth"
  import { cache, memoryStore } from "misina/cache"
  import { cookieJar, MemoryCookieJar } from "misina/cookie"

  const api = createMisina({
    baseURL,
    use: [
      bearer(() => store.token),
      cache({ store: memoryStore() }),
      cookieJar(new MemoryCookieJar()),
    ],
  })
  ```

  Plugins are applied left-to-right: first is innermost, last is outermost.

- Stay zero-deps. Peer deps (e.g. `unstorage`) are fine but document them.

## When in doubt

- Look at `unemail`/`sumak` for house style.
- Read the comments in `src/types.ts` — they encode design decisions.
- The GitHub issues on `productdevbook/misina` document why each feature
  exists. Reference them in commits.

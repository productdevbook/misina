# misina — agents guide

Driver-based, zero-dependency, fetch-first TypeScript HTTP client. Hooks
lifecycle, retry, error taxonomy, and the Web Fetch API as the canonical
wire format.

This file is for coding agents (Claude Code, Cursor, etc.). Read it before
making changes.

## Architectural commitments (locked)

1. **Fetch-first.** Drivers consume a real `Request` and return a real `Response`.
2. **ESM-only.** No CJS, no UMD. Match `unemail`/`sumak`.
3. **Zero core deps.** Subpath helpers may declare peer dependencies.
4. **`AbortSignal.any` required.** Floor: Node 20.5+, Bun, Deno, modern browsers.
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
  dedupe/              — withDedupe
  cache/               — withCache + memoryStore
  auth/                — withBearer / withBasic / withRefreshOn401 / withCsrf
  cookie/              — MemoryCookieJar + withCookieJar
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
- Take a `Misina` instance as its first arg (`withFoo(misina, opts)`) and return a `Misina`.
- Use `misina.extend({ hooks: { ... } })` to plug in.
- Stay zero-deps. Peer deps (e.g. `unstorage`) are fine but document them.

## When in doubt

- Look at `unemail`/`sumak` for house style.
- Read the comments in `src/types.ts` — they encode design decisions.
- The 34 GitHub issues on `productdevbook/misina` document why each
  feature exists. Reference them in commits.

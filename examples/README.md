# misina examples

Hand-runnable scripts that exercise misina's main features. Run with `tsx`
or `bun` from the repo root:

```sh
pnpm dlx tsx examples/01-basic.ts
pnpm dlx tsx examples/02-hooks.ts
pnpm dlx tsx examples/03-retry.ts
pnpm dlx tsx examples/04-status-catchers.ts
pnpm dlx tsx examples/05-paginate.ts
pnpm dlx tsx examples/06-sse.ts
pnpm dlx tsx examples/07-typed.ts
pnpm dlx tsx examples/08-idempotency.ts
pnpm dlx tsx examples/09-problem-details.ts
pnpm dlx tsx examples/10-breaker.ts
pnpm dlx tsx examples/11-modern.ts
```

| #   | Topic                                                                   |
| --- | ----------------------------------------------------------------------- |
| 01  | Basic GET/POST, auto JSON, timings                                      |
| 02  | Hooks lifecycle (init / beforeRequest / afterResponse / beforeError)    |
| 03  | Retry with `Retry-After` honored                                        |
| 04  | `.onError(matcher, handler)` — status / class / predicate matchers      |
| 05  | `paginate()` — async iterator over `Link: rel="next"`                   |
| 06  | `sseStream()` — Server-Sent Events                                      |
| 07  | `createMisinaTyped<E>()` — path / params / body / response inference    |
| 08  | `idempotencyKey: 'auto'` — UUID `Idempotency-Key` for retried mutations |
| 09  | RFC 9457 problem+json on `HTTPError.problem`                            |
| 10  | Circuit breaker (`misina/breaker`) — Polly-shaped state machine         |
| 11  | `priority` hint + `beforeRetry` returning a fallback `Response`         |

01–07 hit real public APIs (httpbin.org, GitHub) — no auth needed.
08–11 use local drivers and run fully offline.

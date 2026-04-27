# misina + React Router v7 (formerly Remix)

Server-side `loader` + `action` flow with misina dispatching the
upstream call. Same shape Remix users had — `loader` returns typed
data, `action` writes and revalidates — but the network layer is one
misina instance with auth + retry + breaker baked in once.

## What's shown

- `app/lib/api.server.ts` — module-singleton misina built once on the
  server, reused across every loader/action call (no per-request
  factory cost)
- `loader` returning `MisinaResponse<T>['data']` directly — the
  framework gets parsed JSON without a manual `await response.json()`
- `action` posting with `idempotencyKey: 'auto'` so a refresh after a
  failed write doesn't double-create
- Centralized error handling via the route's `ErrorBoundary` reading
  `isHTTPError(thrown)`

## Run

```sh
pnpm install
pnpm dev
```

Hits jsonplaceholder.typicode.com; no auth required.

# misina + SvelteKit

Server-side `load` function dispatching the upstream call via misina,
plus a form action that mutates and returns. Mirrors the Remix /
React Router shape but in SvelteKit's idiom.

## What's shown

- `src/lib/api.server.ts` — module-singleton misina (server-only —
  filename suffix `.server.ts` keeps it out of the client bundle)
- `+page.server.ts` `load` returns parsed `User[]`, no `await
res.json()` boilerplate
- Form action posts a new comment with `idempotencyKey: 'auto'`
- `error()` rethrowing as a 502 when upstream is misbehaving

## Run

```sh
pnpm install
pnpm dev
```

Hits jsonplaceholder.typicode.com.

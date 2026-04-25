# misina examples

Hand-runnable scripts that exercise misina's main features against real
public APIs. Run them with `tsx` (or `bun`) from the repo root:

```sh
pnpm dlx tsx examples/01-basic.ts
pnpm dlx tsx examples/02-hooks.ts
pnpm dlx tsx examples/03-retry.ts
pnpm dlx tsx examples/04-status-catchers.ts
pnpm dlx tsx examples/05-paginate.ts
pnpm dlx tsx examples/06-sse.ts
pnpm dlx tsx examples/07-typed.ts
```

These scripts call public APIs (httpbin.org, GitHub, etc.) — no auth
required for any of them. They print to stdout and exit.

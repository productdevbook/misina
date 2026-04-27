# misina + TanStack Query

End-to-end React app showing the canonical pairing: misina dispatches
the request and surfaces typed `MisinaResponse<T>` + `HTTPError<E>`,
TanStack Query owns the cache, retries, and component-level state.

The plugin slot does the long-lived concerns once (auth, breaker,
in-flight dedupe), and per-call hooks pull `meta` for query-key tagging
so you can target invalidation precisely.

## What's shown

- `createMisina({ use: [bearer(...), breaker(...), dedupe()] })` —
  one client, three plugins
- `useQuery` + `useMutation` with `MisinaResponse<T>` directly as the
  return type
- `isHTTPError<E>` + `error.problem` (RFC 9457) feeding component error
  states
- Query invalidation by `meta.tag` — set on the request, read in a
  hook, looped back into `queryClient.invalidateQueries`

## Run

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173. The example calls https://jsonplaceholder.typicode.com — no auth needed; the `bearer()` plugin is wired but the demo source returns a constant token.

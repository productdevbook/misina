# misina + Hono (server-side outbound)

Demonstrates the **server-as-client** pattern: a Hono server takes
inbound requests, talks to upstream services via misina, and responds.
The Hono runtime serves clients; misina handles every outbound call.

This is the shape every BFF / aggregator / API-gateway service ends up
with. misina earns its keep here:

- one-time plugin chain (auth, breaker, rate-limit, tracing) shared
  across thousands of upstream calls per second
- per-request `meta.requestId` propagated through hooks for log
  correlation
- typed responses with `MisinaResponse<T>` instead of opaque `Response`

## What's shown

- `src/api.ts` — single misina instance per service, plugins wired
- `src/index.ts` — Hono routes that proxy + reshape upstream JSON
- structured error mapping: misina's `HTTPError` → Hono's
  `c.json(..., status)` with `problem+json` passthrough
- request-id correlation: Hono middleware reads `x-request-id`,
  misina forwards it via `meta` + a `beforeRequest` hook

## Run

```sh
pnpm install
pnpm dev
# in another terminal:
curl http://localhost:8787/users/1
```

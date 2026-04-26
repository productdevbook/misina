# Benchmarks

Reproducible micro-benchmark suite for misina. Runs against ofetch, ky,
axios, and native `fetch` over a local `node:http` fixture so we can
spot regressions across releases without being at the mercy of the
public internet.

## Run

```sh
pnpm bench
```

The script builds the package first (`pnpm build`) so the numbers
reflect the actual ESM bundle that ships to npm — not the TS source.

## Suites

| Suite                                    | What it measures                                 |
| ---------------------------------------- | ------------------------------------------------ |
| `steady-state GET (200 OK + JSON parse)` | Steady-state hot loop on a small JSON GET        |
| `POST JSON body (+ JSON parse)`          | Same but with a JSON request body                |
| `hooks overhead (no hooks vs 5 hooks)`   | Cost of the hook chain in isolation              |
| `retry on 503 → 200`                     | Full retry path including parsing (1 ms backoff) |
| `createMisina() cold start`              | Instance construction by itself                  |

`bench/server.mjs` is a tiny `node:http` fixture exposing
`GET /users/:id`, `POST /echo`, and `GET /flaky?fail=N&key=K` (returns
503 the first N times then 200, deterministic per `key`).

## Sample results

Node 24.11 / Apple M3 Max / arm64-darwin. Lower is better. Anything
in the same ±20% band on a given laptop is **noise**, not a real
difference; library overhead disappears under any real network's
millisecond floor.

### Steady GET (200 OK + JSON parse)

| Library      |   Avg |    p99 |
| ------------ | ----: | -----: |
| ofetch       | 64 µs |  90 µs |
| native fetch | 72 µs | 170 µs |
| ky           | 73 µs | 122 µs |
| **misina**   | 79 µs | 152 µs |
| axios        | 82 µs | 152 µs |

### POST JSON body (+ JSON parse)

| Library      |    Avg |    p99 |
| ------------ | -----: | -----: |
| ofetch       |  80 µs | 121 µs |
| native fetch |  84 µs | 154 µs |
| axios        |  86 µs | 130 µs |
| ky           | 107 µs | 193 µs |
| **misina**   | 129 µs | 270 µs |

> POST is heavier on misina because the typed pipeline serializes the
> body, runs hooks, and re-parses the JSON response back into
> `result.data` so the call site sees a typed object. ofetch is the
> baseline because it does the same work without the hook chain.

### Other measurements

| Operation                               |       Time |
| --------------------------------------- | ---------: |
| `createMisina()` cold start             | **198 ns** |
| Hook overhead (5 noop `beforeRequest`)  |  **+8 µs** |
| Retry 503 → 200 (1 retry, 1 ms backoff) |    1.52 ms |

## Reading the output

mitata prints the full distribution with sparkline percentiles:

```
benchmark                   avg (min … max) p75 / p99    (min … top 1%)
------------------------------------------- -------------------------------
ofetch                       64.58 µs/iter   64.38 µs   ▂███
                       (44.92 µs … 2.97 ms)  90.38 µs   ▂███▃
```

- **avg / p75 / p99** is what you want for steady-state comparisons.
- **min** is best-case (cache lines hot, GC quiet).
- **max** picks up GC pauses and is usually noise.

When in doubt, run twice and look at the **p75** column — it survives
GC noise better than `avg` and is what most production p95 latencies
look like under healthy load.

## Adding a new suite

Edit [`bench/run.mjs`](./run.mjs):

```js
group("my new suite", () => {
  bench("native fetch", async () => {
    /* ... */
  })
  bench("misina", async () => {
    /* ... */
  })
})
```

Mitata's `bench`, `group`, and `run` cover everything we need; no
custom harness, no per-test bookkeeping.

## Notes on what these _don't_ prove

- **Localhost ≠ the internet.** Real-world latency dwarfs library
  overhead. A 50 ms RTT to the nearest region erases every µs you'd
  win or lose between these libraries.
- **Single-request paths only.** Pool-tuning gains from
  `misina/driver/undici` (`connections`, `pipelining`, `allowH2`) are
  most visible at concurrency, which this suite intentionally doesn't
  cover yet.
- **Same Node version for every entry.** ofetch/ky/axios all sit on
  top of the same `globalThis.fetch` here, so we're comparing
  _wrapper_ overhead, not transport choice.

These exist so refactors don't quietly inflate the hot path. They're
not meant to declare a winner.

// Benchmark suite — measures misina against ofetch / ky / axios /
// native fetch on a local Node HTTP server. Run via `pnpm bench`.
// Reports throughput per suite; exits 0 on success.

import { bench, group, run } from "mitata"
import axios from "axios"
import ky from "ky"
import { ofetch } from "ofetch"

import { createMisina, HTTPError } from "../dist/index.mjs"
import { bearer } from "../dist/auth/index.mjs"
import { breaker } from "../dist/breaker/index.mjs"
import { tracing } from "../dist/tracing/index.mjs"
import { startServer } from "./server.mjs"

const server = await startServer()
const BASE = server.url

const misina = createMisina({ baseURL: BASE, retry: 0 })
const misinaWith5Hooks = createMisina({
  baseURL: BASE,
  retry: 0,
  hooks: {
    beforeRequest: [(ctx) => ctx, (ctx) => ctx, (ctx) => ctx, (ctx) => ctx, (ctx) => ctx],
  },
})
const misinaRetry = createMisina({
  baseURL: BASE,
  retry: { limit: 3, delay: () => 1, retryOnNetworkError: true },
})

// Plugin scenarios. Each is built once outside the bench loop so we
// only measure dispatch cost, not factory cost.
const misinaOnePlugin = createMisina({
  baseURL: BASE,
  retry: 0,
  use: [bearer("token")],
})
const misinaThreePlugins = createMisina({
  baseURL: BASE,
  retry: 0,
  use: [bearer("token"), tracing(), breaker({ failureThreshold: 100 })],
})

// Warm DNS / TLS / V8 inlining so the first sample isn't an outlier.
await Promise.all([
  fetch(`${BASE}/users/1`).then((r) => r.text()),
  ofetch(`${BASE}/users/1`),
  ky.get(`${BASE}/users/1`).text(),
  axios.get(`${BASE}/users/1`),
  misina.get("/users/1"),
  misinaOnePlugin.get("/users/1"),
  misinaThreePlugins.get("/users/1"),
])

group("steady-state GET (200 OK, JSON parse)", () => {
  bench("native fetch", async () => {
    const r = await fetch(`${BASE}/users/1`)
    await r.json()
  })
  bench("ofetch", async () => {
    await ofetch(`${BASE}/users/1`)
  })
  bench("ky", async () => {
    await ky.get(`${BASE}/users/1`).json()
  })
  bench("axios", async () => {
    await axios.get(`${BASE}/users/1`)
  })
  bench("misina", async () => {
    await misina.get("/users/1")
  })
})

group("POST JSON body", () => {
  const body = { hello: "world", n: 42 }
  bench("native fetch", async () => {
    const r = await fetch(`${BASE}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    await r.json()
  })
  bench("ofetch", async () => {
    await ofetch(`${BASE}/echo`, { method: "POST", body })
  })
  bench("ky", async () => {
    await ky.post(`${BASE}/echo`, { json: body }).json()
  })
  bench("axios", async () => {
    await axios.post(`${BASE}/echo`, body)
  })
  bench("misina", async () => {
    await misina.post("/echo", body)
  })
})

group("hooks overhead (no hooks vs 5 hooks)", () => {
  bench("misina — no hooks", async () => {
    await misina.get("/users/1")
  })
  bench("misina — 5 hooks", async () => {
    await misinaWith5Hooks.get("/users/1")
  })
})

group("plugin overhead (no plugins / 1 hook plugin / 3 plugins inc. wrapping)", () => {
  bench("misina — no plugins", async () => {
    await misina.get("/users/1")
  })
  bench("misina — bearer", async () => {
    await misinaOnePlugin.get("/users/1")
  })
  bench("misina — bearer + tracing + breaker", async () => {
    await misinaThreePlugins.get("/users/1")
  })
})

group("retry on 503 → 200", () => {
  bench("misina — retry 1× then 200", async () => {
    const key = `bench-${Math.random()}`
    try {
      await misinaRetry.get(`/flaky?fail=1&key=${key}`)
    } catch (e) {
      if (!(e instanceof HTTPError)) throw e
    }
  })
})

group("createMisina cold start", () => {
  bench("createMisina()", () => {
    createMisina({ baseURL: BASE })
  })
  bench("createMisina({ use: [bearer] })", () => {
    createMisina({ baseURL: BASE, use: [bearer("token")] })
  })
  bench("createMisina({ use: [bearer, tracing, breaker] })", () => {
    createMisina({
      baseURL: BASE,
      use: [bearer("token"), tracing(), breaker({ failureThreshold: 100 })],
    })
  })
})

await run({ percentiles: false })

await server.close()

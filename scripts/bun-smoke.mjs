// Minimal Bun smoke test — verifies the dist works under Bun's runtime.
// We don't run the full vitest suite under `bun test` because Bun's native
// fetch / Request implementation has its own quirks around redirect+body
// retention and signal cloning that test against Node's undici behavior.
// Run with: bun scripts/bun-smoke.mjs

import { createMisina, defineDriver } from "../dist/index.mjs"
import mockDriverFactory from "../dist/driver/mock.mjs"

const mock = mockDriverFactory({
  response: new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }),
})

const api = createMisina({ driver: mock, retry: 0 })
const res = await api.get("https://example.test/")

if (res.status !== 200 || res.data.ok !== true) {
  console.error("Bun smoke test failed:", res)
  process.exit(1)
}

// Custom driver via defineDriver
const echoDriver = defineDriver(() => ({
  name: "echo",
  request: async (req) => new Response(req.url),
}))()
const api2 = createMisina({ driver: echoDriver, retry: 0, throwHttpErrors: false })
const res2 = await api2.get("https://example.test/echo", { responseType: "text" })
if (res2.data !== "https://example.test/echo") {
  console.error("Bun custom-driver smoke failed:", res2.data)
  process.exit(1)
}

// AbortSignal.any — Bun ≥ 1.2 has it natively.
const composedDriver = defineDriver(() => ({
  name: "compose",
  request: async (req) => {
    if (!req.signal) throw new Error("expected a signal")
    return new Response("ok")
  },
}))()
const controller = new AbortController()
const api3 = createMisina({ driver: composedDriver, retry: 0, signal: controller.signal })
await api3.get("https://example.test/", { responseType: "text" })

console.log("✅ Bun smoke ok")

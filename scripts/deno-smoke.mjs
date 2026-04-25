// Minimal Deno smoke test — verifies the dist works under Deno's runtime.
// Run with: deno run --allow-net --allow-read scripts/deno-smoke.mjs

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
  console.error("Deno smoke test failed:", res)
  // eslint-disable-next-line no-undef
  Deno.exit(1)
}

// Custom driver via defineDriver
const echoDriver = defineDriver(() => ({
  name: "echo",
  request: async (req) => new Response(req.url),
}))()
const api2 = createMisina({ driver: echoDriver, retry: 0, throwHttpErrors: false })
const res2 = await api2.get("https://example.test/echo", { responseType: "text" })
if (res2.data !== "https://example.test/echo") {
  console.error("Deno custom driver test failed:", res2)
  // eslint-disable-next-line no-undef
  Deno.exit(1)
}

console.log("✅ Deno smoke test passed")

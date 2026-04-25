/**
 * Circuit breaker — fail fast when a downstream is down.
 *
 *   closed ──[N failures]──▶ open
 *   open   ──[wait halfOpenAfter]──▶ half-open (one probe allowed)
 *   half-open ──[probe ok]──▶ closed
 *   half-open ──[probe fails]──▶ open (fresh timer)
 *
 * 4xx is intentionally NOT counted as a failure (it's a client mistake,
 * not a service degradation). 5xx and network errors trip the breaker.
 *
 * Run: pnpm dlx tsx examples/10-breaker.ts
 */
import { createMisina } from "../src/index.ts"
import { CircuitOpenError, withCircuitBreaker } from "../src/breaker/index.ts"

// Pretend a service that's down. Local driver so the example is offline-safe.
const driver = {
  name: "down-service",
  request: async () => new Response(null, { status: 503 }),
}

const api = withCircuitBreaker(createMisina({ driver, retry: 0 }), {
  failureThreshold: 3,
  halfOpenAfter: 200,
})

console.log("state:", api.breaker.state())

// Three consecutive 503s trip the breaker.
for (let i = 0; i < 3; i++) {
  await api.get("https://api.test/").catch(() => {})
}
console.log("state after 3 failures:", api.breaker.state())

// Now subsequent calls reject FAST without hitting the network.
const t0 = performance.now()
try {
  await api.get("https://api.test/")
} catch (err) {
  if (err instanceof CircuitOpenError) {
    console.log(
      "fast-rejected in",
      (performance.now() - t0).toFixed(1),
      "ms — retry after",
      err.retryAfter,
      "ms",
    )
  }
}

// Wait past halfOpenAfter and the breaker probes again.
await new Promise((r) => setTimeout(r, 250))
console.log("state after timer:", api.breaker.state(), "(open — will probe on next call)")

// Manual control:
api.breaker.trip()
console.log("after .trip():", api.breaker.state())
api.breaker.reset()
console.log("after .reset():", api.breaker.state())

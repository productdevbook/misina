/**
 * Auto-generated Idempotency-Key for retried mutations.
 *
 * When a POST/PATCH/DELETE is retried (network blip, 503, etc.) you don't
 * want the server to apply the side-effect twice. Misina sets a stable
 * `crypto.randomUUID()` as `Idempotency-Key` on the first attempt and
 * reuses it across all retries — your server just deduplicates.
 *
 * Per draft-ietf-httpapi-idempotency-key-header.
 *
 * Run: pnpm dlx tsx examples/08-idempotency.ts
 */
import { createMisina } from "../src/index.ts"

const api = createMisina({
  baseURL: "https://httpbin.org",
  // 'auto' generates crypto.randomUUID() per logical call.
  // Idempotent methods (GET/HEAD/OPTIONS/PUT) are skipped — already safe.
  idempotencyKey: "auto",
  retry: {
    limit: 2,
    methods: ["POST"], // POST not retried by default
    delay: () => 200,
  },
})

const res = await api.post<{ headers: Record<string, string> }>("/post", {
  amount: 100,
  currency: "USD",
})

console.log("Idempotency-Key sent:", res.data.headers["Idempotency-Key"])
console.log("(server saw the same key on every attempt)")

// Or pass a stable key from your own request id:
const tracedApi = createMisina({
  baseURL: "https://httpbin.org",
  idempotencyKey: () => `order-${Date.now()}`,
  retry: { limit: 1, methods: ["POST"], delay: () => 1 },
})

const traced = await tracedApi.post<{ headers: Record<string, string> }>("/post", { x: 1 })
console.log("custom key:", traced.data.headers["Idempotency-Key"])

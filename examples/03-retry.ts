/**
 * Retry against httpbin's flaky endpoint with Retry-After honored.
 * Run: pnpm dlx tsx examples/03-retry.ts
 */
import { createMisina, isHTTPError } from "../src/index.ts"

const api = createMisina({
  baseURL: "https://httpbin.org",
  retry: {
    limit: 3,
    delay: (attempt) => attempt * 200,
    statusCodes: [503],
  },
  hooks: {
    beforeRetry: (ctx) => {
      console.log(`[retry #${ctx.attempt}]`, "after", ctx.error)
    },
  },
})

try {
  // /status/503 always returns 503
  await api.get("/status/503")
} catch (err) {
  if (isHTTPError(err)) {
    console.log("final status:", err.status, "after retries.")
  }
}

/**
 * Two small modern features:
 *   1) `priority: 'high' | 'low' | 'auto'` — fetch priority hint.
 *   2) `beforeRetry` returning a `Response` to short-circuit retries with
 *      a synthesized response (cache fallback, default values, etc).
 *
 * Run: pnpm dlx tsx examples/11-modern.ts
 */
import { createMisina } from "../src/index.ts"

// ── 1) priority ───────────────────────────────────────────────────────────
//
// Tag user-blocking calls 'high' and prefetch / background work 'low'.
// Honored by Chromium browsers, Firefox 132+, Safari 17.4+, Workers.

const fast = createMisina({
  baseURL: "https://httpbin.org",
  priority: "high",
})

const r = await fast.get<{ url: string }>("/get")
console.log("high-priority call →", r.data.url)

// ── 2) beforeRetry → Response (cache fallback) ────────────────────────────
//
// When upstream is degraded, you can serve a stale-but-valid response
// from your own cache instead of bubbling an error to the user. Misina
// finalizes that Response as if it came from the network.

const cache = new Map<string, unknown>()
cache.set("https://api.test/feed", { items: ["cached-1", "cached-2"], stale: true })

const driver = {
  name: "always-503",
  request: async () => new Response(null, { status: 503 }),
}

const api = createMisina({
  driver,
  retry: { limit: 1, delay: () => 50 },
  hooks: {
    beforeRetry: (ctx) => {
      const cached = cache.get(ctx.request.url)
      if (cached) {
        console.log("upstream down — serving cache for", ctx.request.url)
        return new Response(JSON.stringify(cached), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
    },
  },
})

const res = await api.get<{ items: string[]; stale: boolean }>("https://api.test/feed")
console.log("got →", res.data)
console.log("stale flag carried through:", res.data.stale)

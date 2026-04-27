import { createMisina } from "misina"
import { bearer } from "misina/auth"
import { breaker } from "misina/breaker"
import { rateLimit } from "misina/ratelimit"
import { tracing } from "misina/tracing"

declare module "misina" {
  interface MisinaMeta {
    /** Inbound x-request-id, propagated downstream. */
    requestId?: string
  }
}

/**
 * Singleton misina for this service. Built once on cold start.
 * Plugins compose the cross-cutting concerns:
 *   - bearer: outbound auth
 *   - breaker: circuit-break the upstream so a sustained outage
 *     fails fast for our clients instead of queueing 30s timeouts
 *   - rateLimit: respect upstream rpm + react to 429
 *   - tracing: W3C traceparent so distributed traces line up
 */
export const upstream = createMisina({
  baseURL: "https://jsonplaceholder.typicode.com",
  retry: 2,
  timeout: 5_000,
  use: [
    bearer(() => process.env.UPSTREAM_TOKEN ?? "demo-token"),
    breaker({ failureThreshold: 5, halfOpenAfter: 30_000 }),
    rateLimit({ rpm: 600 }),
    tracing(),
  ],
  hooks: {
    // Forward the inbound request-id to upstream so the trace lines
    // up across both hops.
    beforeRequest: (ctx) => {
      const id = ctx.options.meta.requestId
      if (!id) return
      const headers = new Headers(ctx.request.headers)
      headers.set("x-request-id", id)
      return new Request(ctx.request, { headers })
    },
  },
})

export interface User {
  id: number
  name: string
  email: string
  username: string
}

export interface Post {
  userId: number
  id: number
  title: string
  body: string
}

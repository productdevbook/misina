import { createMisina } from "misina"
import { bearer } from "misina/auth"
import { breaker } from "misina/breaker"

/**
 * Server-only misina instance — the `.server.ts` suffix keeps SvelteKit
 * from bundling this into the client. Built once at module load.
 */
export const api = createMisina({
  baseURL: "https://jsonplaceholder.typicode.com",
  retry: 2,
  timeout: 10_000,
  use: [
    bearer(() => process.env.UPSTREAM_TOKEN ?? "demo-token"),
    breaker({ failureThreshold: 5, halfOpenAfter: 30_000 }),
  ],
})

export interface User {
  id: number
  name: string
  email: string
  username: string
}

export interface Comment {
  postId: number
  id: number
  name: string
  email: string
  body: string
}

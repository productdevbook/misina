import { createMisina } from "misina"
import { bearer } from "misina/auth"
import { breaker } from "misina/breaker"

/**
 * Server-side singleton. React Router v7 modules survive across
 * requests, so building the misina instance once at module load is
 * both correct and free.
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

export interface Post {
  userId: number
  id: number
  title: string
  body: string
}

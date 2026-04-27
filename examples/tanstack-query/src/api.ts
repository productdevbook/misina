import { createMisina, type MisinaResponse } from "misina"
import { bearer } from "misina/auth"
import { breaker } from "misina/breaker"
import { dedupe } from "misina/dedupe"

declare module "misina" {
  interface MisinaMeta {
    /** Tag a request so the query layer can invalidate by audience. */
    tag?: "user" | "post" | "comment"
  }
}

/**
 * Single misina instance, shared across every query/mutation.
 * - `bearer` adds Authorization (token source is sync here, but a
 *   real app would point at a session store).
 * - `breaker` fails fast when the upstream is down — protects the
 *   user from a stampede of slow timeouts.
 * - `dedupe` collapses concurrent identical GETs onto one request,
 *   useful when several components mount the same query at once.
 */
export const api = createMisina({
  baseURL: "https://jsonplaceholder.typicode.com",
  retry: 2,
  timeout: 10_000,
  use: [
    bearer(() => "demo-token"),
    breaker({ failureThreshold: 5, halfOpenAfter: 30_000 }),
    dedupe(),
  ],
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

export async function listUsers(): Promise<MisinaResponse<User[]>> {
  return api.get<User[]>("/users", { meta: { tag: "user" } })
}

export async function listPosts(userId: number): Promise<MisinaResponse<Post[]>> {
  return api.get<Post[]>("/posts", {
    query: { userId },
    meta: { tag: "post" },
  })
}

export async function createPost(body: Omit<Post, "id">): Promise<MisinaResponse<Post>> {
  return api.post<Post>("/posts", body, {
    meta: { tag: "post" },
    idempotencyKey: "auto",
  })
}

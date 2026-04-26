/**
 * Next.js helpers: tag-invalidation hook + a small `tag()` builder.
 *
 * Wires misina's per-request `meta.invalidates` to Next.js's
 * `revalidateTag()` so a successful mutation triggers cache
 * invalidation in one line:
 *
 * ```ts
 * import { onTagInvalidate, tag } from "misina/runtime/next"
 * import { revalidateTag } from "next/cache"
 *
 * const api = onTagInvalidate(createMisina({ baseURL }), revalidateTag)
 *
 * await api.post("/users", body, {
 *   meta: { invalidates: [tag("users", "list"), tag("user", "by-id", "42")] },
 * })
 * // → revalidateTag('users:list') and revalidateTag('user:by-id:42') after success
 * ```
 *
 * Only fires on successful (non-error) responses to avoid invalidating
 * caches on a transient failure.
 */

import type { Misina } from "../../types.ts"

declare module "../../types.ts" {
  interface MisinaMeta {
    /**
     * Tags to invalidate after a successful response. Wired up by
     * `onTagInvalidate(misina, revalidateTag)` from `misina/runtime/next`.
     */
    invalidates?: string[]
  }
}

export type RevalidateTagFn = (tag: string) => void | Promise<void>

export function onTagInvalidate(misina: Misina, revalidateTag: RevalidateTagFn): Misina {
  return misina.extend({
    hooks: {
      onComplete: async ({ response, error, options }) => {
        if (error || !response || !response.ok) return
        const tags = options.meta?.invalidates
        if (!tags || tags.length === 0) return
        await Promise.all(tags.map((t) => revalidateTag(t)))
      },
    },
  })
}

/**
 * Compose a hierarchical tag string by joining parts with `:`. Pure
 * helper — use whatever delimiter style your team already prefers.
 */
export function tag(...parts: string[]): string {
  return parts.join(":")
}

import { isHTTPError } from "misina"
import { error, fail } from "@sveltejs/kit"
import type { Actions, PageServerLoad } from "./$types"
import { api, type Comment, type User } from "$lib/api.server"

export const load: PageServerLoad = async () => {
  try {
    const res = await api.get<User[]>("/users")
    return { users: res.data }
  } catch (err) {
    if (isHTTPError(err)) throw error(502, `Upstream ${err.status}`)
    throw err
  }
}

export const actions: Actions = {
  comment: async ({ request }) => {
    const form = await request.formData()
    const body = String(form.get("body") ?? "").trim()
    if (!body) return fail(400, { error: "body required" })

    const res = await api.post<Comment>(
      "/comments",
      { postId: 1, name: "anon", email: "a@b.test", body },
      { idempotencyKey: "auto" },
    )
    return { created: res.data }
  },
}

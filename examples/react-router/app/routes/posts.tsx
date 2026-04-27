import { isHTTPError } from "misina"
import { Form, useLoaderData } from "react-router"
import { api, type Post } from "../lib/api.server"

export async function loader() {
  const res = await api.get<Post[]>("/posts")
  return { posts: res.data.slice(0, 10) }
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData()
  const title = String(form.get("title") ?? "")
  if (!title) return { error: "title required" }

  const res = await api.post<Post>(
    "/posts",
    { userId: 1, title, body: "from react-router" },
    { idempotencyKey: "auto" },
  )
  return { created: res.data }
}

export function ErrorBoundary({ error }: { error: unknown }) {
  if (isHTTPError(error)) {
    return (
      <div>
        <h1>Upstream {error.status}</h1>
        <p>{error.problem?.detail ?? error.message}</p>
      </div>
    )
  }
  throw error
}

export default function Posts() {
  const { posts } = useLoaderData<typeof loader>()
  return (
    <main>
      <h1>Posts (first 10)</h1>
      <Form method="post">
        <input name="title" placeholder="New post title" />
        <button type="submit">Create</button>
      </Form>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>
    </main>
  )
}

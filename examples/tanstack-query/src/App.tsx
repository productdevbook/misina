import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { isHTTPError } from "misina"
import { useState } from "react"
import { createPost, listPosts, listUsers, type Post, type User } from "./api"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Let misina's plugin chain handle network-level retry; the
      // query layer only retries on terminal misses, not on flakes.
      retry: 0,
      staleTime: 30_000,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Users />
    </QueryClientProvider>
  )
}

function Users() {
  const [selected, setSelected] = useState<number | null>(null)
  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => (await listUsers()).data,
  })

  if (users.isPending) return <p>Loading users…</p>
  if (users.isError) return <ErrorView error={users.error} />

  return (
    <div>
      <ul>
        {users.data?.map((u: User) => (
          <li key={u.id}>
            <button onClick={() => setSelected(u.id)}>{u.name}</button>
          </li>
        ))}
      </ul>
      {selected != null && <Posts userId={selected} />}
    </div>
  )
}

function Posts({ userId }: { userId: number }) {
  const qc = useQueryClient()
  const posts = useQuery({
    queryKey: ["posts", userId],
    queryFn: async () => (await listPosts(userId)).data,
  })
  const create = useMutation({
    mutationFn: async (input: Omit<Post, "id">) => (await createPost(input)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["posts", userId] }),
  })

  if (posts.isPending) return <p>Loading posts…</p>
  if (posts.isError) return <ErrorView error={posts.error} />

  return (
    <div>
      <button
        onClick={() =>
          create.mutate({ userId, title: "Hello from misina", body: "tanstack + misina" })
        }
        disabled={create.isPending}
      >
        Add post
      </button>
      <ul>
        {posts.data?.map((p) => (
          <li key={p.id}>
            <strong>{p.title}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ErrorView({ error }: { error: unknown }) {
  if (isHTTPError(error)) {
    return (
      <p>
        HTTP {error.status}
        {error.problem?.title ? ` — ${error.problem.title}` : ""}
      </p>
    )
  }
  return <p>{error instanceof Error ? error.message : String(error)}</p>
}

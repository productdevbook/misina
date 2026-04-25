/**
 * Type-safe path generics + path-param substitution.
 * Run: pnpm dlx tsx examples/07-typed.ts
 */
import { createMisinaTyped } from "../src/index.ts"

interface Repo {
  name: string
  full_name: string
  description: string | null
  stargazers_count: number
  language: string | null
}

interface User {
  login: string
  name: string
  public_repos: number
}

type GitHubApi = {
  "GET /users/:login": { params: { login: string }; response: User }
  "GET /repos/:owner/:repo": {
    params: { owner: string; repo: string }
    response: Repo
  }
}

const gh = createMisinaTyped<GitHubApi>({
  baseURL: "https://api.github.com",
  headers: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  },
})

const { data: user } = await gh.get("/users/:login", {
  params: { login: "octocat" },
})

console.log(`${user.name} (@${user.login}) — ${user.public_repos} public repos`)

const { data: repo } = await gh.get("/repos/:owner/:repo", {
  params: { owner: "octocat", repo: "Hello-World" },
})

console.log(`${repo.full_name} — ★ ${repo.stargazers_count} — ${repo.language ?? "no language"}`)
console.log(repo.description ?? "(no description)")

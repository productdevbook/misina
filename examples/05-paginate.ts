/**
 * Paginate GitHub's public REST API following Link rel=next automatically.
 * Run: pnpm dlx tsx examples/05-paginate.ts
 */
import { createMisina } from "../src/index.ts"
import { paginate } from "../src/paginate/index.ts"

const api = createMisina({
  baseURL: "https://api.github.com",
  headers: {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  },
})

let count = 0
for await (const repo of paginate<{ name: string; stargazers_count: number }>(
  api,
  "/users/productdevbook/repos?per_page=10",
  { countLimit: 25 },
)) {
  count++
  console.log(`${count.toString().padStart(2)}. ${repo.name}  ★ ${repo.stargazers_count}`)
}

console.log(`\ndone — ${count} repos`)

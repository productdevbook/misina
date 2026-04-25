/**
 * Basic GET / POST with auto-JSON serialization and parsing.
 * Run: pnpm dlx tsx examples/01-basic.ts
 */
import { createMisina } from "../src/index.ts"

const api = createMisina({ baseURL: "https://httpbin.org" })

const get = await api.get<{ url: string }>("/get", { query: { hello: "world" } })
console.log("GET →", get.data.url)
console.log("timings →", `${get.timings.total.toFixed(1)}ms`)

const post = await api.post<{ json: { a: number } }>("/post", { a: 42 })
console.log("POST →", post.data.json)

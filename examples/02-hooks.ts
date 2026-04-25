/**
 * Full hooks lifecycle in action.
 * Run: pnpm dlx tsx examples/02-hooks.ts
 */
import { createMisina } from "../src/index.ts"

const api = createMisina({
  baseURL: "https://httpbin.org",
  hooks: {
    init: (options) => {
      console.log("[init]      ", options.method, options.url)
      options.headers["x-misina-trace"] = crypto.randomUUID()
    },
    beforeRequest: (ctx) => {
      console.log("[before]    ", ctx.request.method, ctx.request.url)
    },
    afterResponse: (ctx) => {
      console.log("[after]     ", ctx.response?.status)
    },
    beforeError: (error) => {
      console.log("[error]     ", error.name, error.message)
      return error
    },
  },
})

await api.get("/headers")

/**
 * Per-status error recovery via .onError(matcher, handler).
 * Run: pnpm dlx tsx examples/04-status-catchers.ts
 */
import { createMisina } from "../src/index.ts"

const api = createMisina({ baseURL: "https://httpbin.org", retry: 0 })

const value = await api
  .get<unknown>("/status/404")
  .onError(404, () => "handled-404")
  .onError([401, 403], () => "auth-required")
  .onError("NetworkError", () => "offline-fallback")

console.log("recovered →", value)

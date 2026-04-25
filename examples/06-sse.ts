/**
 * Consume a Server-Sent Events stream.
 * Run: pnpm dlx tsx examples/06-sse.ts
 *
 * httpbin doesn't host an SSE endpoint, so this uses sse.dev which echoes
 * a message every 2s. Press Ctrl+C to stop.
 */
import { createMisina } from "../src/index.ts"
import { sseStream } from "../src/stream/index.ts"

const api = createMisina({ retry: 0, throwHttpErrors: false })

const res = await api.get("https://sse.dev/test", { responseType: "stream" })

const controller = new AbortController()
setTimeout(() => controller.abort(), 8000) // give up after 8s

let i = 0
try {
  for await (const event of sseStream(res.raw)) {
    if (controller.signal.aborted) break
    console.log(`#${++i}`, event.event, event.data.slice(0, 80))
    if (i >= 3) break
  }
} catch (err) {
  console.log("stream ended:", (err as Error).message)
}

/**
 * Consume a Server-Sent Events stream.
 * Run: pnpm dlx tsx examples/06-sse.ts
 *
 * sse.dev no longer resolves, so this uses DexPaprika's public stream:
 * free, no API key, emits a named `token_price` event with the live WETH
 * price every few seconds (plus `ping` keepalives between price ticks).
 * Docs: https://docs.dexpaprika.com/streaming
 */
import { createMisina } from "../src/index.ts"
import { sseStream } from "../src/stream/index.ts"

const api = createMisina({ retry: 0, throwHttpErrors: false })

const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
const res = await api.get(
  `https://streaming.dexpaprika.com/sse/prices?method=token_price&chain=ethereum&address=${weth}`,
  { responseType: "stream", signal: AbortSignal.timeout(30_000) },
)

let i = 0
try {
  for await (const event of sseStream(res.raw)) {
    if (event.event !== "token_price") continue // skip keepalives
    console.log(`#${++i}`, event.event, event.data.slice(0, 80))
    if (i >= 3) break
  }
} catch (err) {
  console.log("stream ended:", (err as Error).message)
}

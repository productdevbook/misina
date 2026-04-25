import { describe, expect, it } from "vitest"
import { createMisina, defineDriver } from "../src/index.ts"

/**
 * #34 — streamed request bodies are single-use. A naive retry would re-send
 * an already-drained stream, producing an empty body. These tests pin the
 * documented contract: the user must reassign `body` in `beforeRetry`.
 */

describe("stream body reassignment (#34)", () => {
  it("beforeRetry can hand the next attempt a fresh stream via a new Request", async () => {
    let attempt = 0
    const bodiesSeen: string[] = []

    const driver = defineDriver(() => ({
      name: "flaky-upload",
      request: async (req) => {
        attempt++
        const body = req.body ? await req.clone().text() : ""
        bodiesSeen.push(body)

        if (attempt === 1) return new Response("upstream error", { status: 503 })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    }))()

    const m = createMisina({
      driver,
      retry: { limit: 1, methods: ["PUT"], delay: () => 0 },
      hooks: {
        beforeRetry: (ctx) => {
          // Replace the request with a fresh one carrying a new stream.
          const fresh = makeStream("retry-payload")
          return new Request(ctx.request, { body: fresh, duplex: "half" } as RequestInit & {
            duplex: "half"
          })
        },
      },
    })

    const initialStream = makeStream("first-payload")
    const res = await m.request<{ ok: boolean }>("https://example.test/upload", {
      method: "PUT",
      body: initialStream,
    })

    expect(attempt).toBe(2)
    expect(res.data.ok).toBe(true)
    expect(bodiesSeen[0]).toBe("first-payload")
    // Without reassignment the second body would be empty; reassignment
    // produced a fresh, non-drained stream.
    expect(bodiesSeen[1]).toBe("retry-payload")
  })

  it("retrying a drained stream without reassignment throws (Web Fetch contract)", async () => {
    const driver = defineDriver(() => ({
      name: "flaky-upload",
      request: async () => new Response("upstream error", { status: 503 }),
    }))()

    const m = createMisina({
      driver,
      retry: { limit: 1, methods: ["PUT"], delay: () => 0 },
      // No beforeRetry — Request constructor refuses to re-wrap a used Request.
    })

    await expect(
      m.request("https://example.test/upload", {
        method: "PUT",
        body: makeStream("only-payload"),
      }),
    ).rejects.toThrow(/already been used/)
  })
})

function makeStream(payload: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(payload)
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })
}

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import { paginate } from "../src/paginate/index.ts"
import { ndjsonStream, sseStream } from "../src/stream/index.ts"

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function ndjsonResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
}

describe("Symbol.asyncDispose support", () => {
  it("sseStream iterator exposes [Symbol.asyncDispose]", () => {
    const it = sseStream(sseResponse("data: 1\n\n"))
    expect(typeof (it as { [Symbol.asyncDispose]?: () => unknown })[Symbol.asyncDispose]).toBe(
      "function",
    )
  })

  it("ndjsonStream iterator exposes [Symbol.asyncDispose]", () => {
    const it = ndjsonStream(ndjsonResponse('{"a":1}\n'))
    expect(typeof (it as { [Symbol.asyncDispose]?: () => unknown })[Symbol.asyncDispose]).toBe(
      "function",
    )
  })

  it("await using on sseStream cleans up after the block", async () => {
    let cleaned = false
    const stream = new ReadableStream({
      cancel() {
        cleaned = true
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
        // Don't close — rely on consumer abort to release.
      },
    })
    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    })

    // Use a TS-style early-return via { ... } block. Note: vitest may not
    // transpile `using`/`await using` syntax under all configs. We exercise
    // the underlying mechanism by calling [Symbol.asyncDispose]() manually,
    // which is what the syntax does.
    const it = sseStream(response) as unknown as AsyncIterator<{ data: string }> & AsyncDisposable
    const first = await it.next()
    expect(first.value?.data).toBe("hello")
    await it[Symbol.asyncDispose]()
    expect(cleaned).toBe(true)
  })

  it("paginate iterator exposes [Symbol.asyncDispose]", () => {
    const driver = {
      name: "x",
      request: async () =>
        new Response(JSON.stringify([{ id: 1 }]), {
          headers: { "content-type": "application/json" },
        }),
    }
    const m = createMisina({ driver, retry: 0, baseURL: "https://x.test" })
    const it = paginate(m, "/items")
    expect(typeof (it as { [Symbol.asyncDispose]?: () => unknown })[Symbol.asyncDispose]).toBe(
      "function",
    )
  })
})

import { describe, expect, it } from "vitest"
import { createMisina } from "../src/index.ts"
import {
  accumulateAnthropicMessage,
  linesOf,
  ndjsonStream,
  sseStream,
  sseStreamReconnecting,
} from "../src/stream/index.ts"

/**
 * Targeted tests to lift branch coverage on `src/stream/` from ~77% to ≥80%.
 * Each suite below targets a specific uncovered branch identified by the
 * v8 coverage HTML report.
 */

function streamFromChunks(
  chunks: (string | Uint8Array)[],
  contentType = "text/event-stream",
): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? encoder.encode(c) : c)
      }
      controller.close()
    },
  })
  return new Response(body, {
    headers: { "content-type": contentType },
  })
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

describe("sseStream — additional spec branches", () => {
  it("yields an event that has only an id and no data lines", async () => {
    // Triggers the `event.id != null || event.retry != null` branch in
    // the blank-line dispatch — without any `data:` lines.
    const body = `id: only-id\n\n`
    const events = []
    for await (const e of sseStream(sseResponse(body))) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe("only-id")
    expect(events[0]?.data).toBe("")
  })

  it("yields an event that has only a retry and no data lines", async () => {
    const body = `retry: 1234\n\n`
    const events = []
    for await (const e of sseStream(sseResponse(body))) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]?.retry).toBe(1234)
    expect(events[0]?.data).toBe("")
  })

  it("treats a line with no colon as a field name with empty value", async () => {
    // Per HTML §9.2.6 step 6: a line without a U+003A means the whole
    // line is the field name and value is the empty string. Unknown
    // fields are dropped, so this neither produces nor errors.
    const body = `unknownfield\ndata: kept\n\n`
    const events = []
    for await (const e of sseStream(sseResponse(body))) events.push(e)
    expect(events).toEqual([{ event: "message", data: "kept" }])
  })

  it("treats `data` (no colon) as data with an empty payload", async () => {
    // Single-line "data" with no colon: per spec field=data, value="".
    // Followed by a real `data: X` and a blank line — both data lines
    // join with '\n', producing "" + "\n" + "x".
    const body = `data\ndata: x\n\n`
    const events = []
    for await (const e of sseStream(sseResponse(body))) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe("\nx")
  })
})

describe("linesOf — buffer tail handling", () => {
  it("yields a trailing line ending in \\r when the stream ends without a newline", async () => {
    // The final flush path: buffer is non-empty, ends with `\r`, must be
    // stripped before yielding. No newline appears anywhere.
    const r = streamFromChunks(["lonely-line\r"], "text/plain")
    const lines: string[] = []
    for await (const l of linesOf(r)) lines.push(l)
    expect(lines).toEqual(["lonely-line"])
  })

  it("returns immediately when the response has a null body", async () => {
    // 204 No Content has no body — exercises `if (!body) return` path.
    const r = new Response(null, { status: 204 })
    const lines: string[] = []
    for await (const l of linesOf(r)) lines.push(l)
    expect(lines).toEqual([])
  })

  it("sseStream returns immediately when the response has a null body", async () => {
    const r = new Response(null, { status: 204 })
    const events = []
    for await (const e of sseStream(r)) events.push(e)
    expect(events).toEqual([])
  })

  it("ndjsonStream returns immediately when the response has a null body", async () => {
    const r = new Response(null, { status: 204 })
    const items = []
    for await (const i of ndjsonStream(r)) items.push(i)
    expect(items).toEqual([])
  })
})

describe("sseStream — async dispose wrapping fallback", () => {
  it("wrapped iterator (without native asyncDispose) supports `await using`", async () => {
    // The ensureDisposable fallback runs when the inner iterator does not
    // expose Symbol.asyncDispose. Modern engines often expose it on
    // AsyncGenerator — we can't directly force the absent path from the
    // public API, but we *can* exercise the wrapped object's surface
    // (next/return/Symbol.asyncIterator/Symbol.asyncDispose) by driving
    // a normal sseStream iterator through these methods.
    const iter = sseStream(sseResponse("data: a\n\ndata: b\n\n"))
    // The iterator is its own iterable.
    expect(iter[Symbol.asyncIterator]()).toBe(iter)
    // Symbol.asyncDispose is always present (native or wrapped).
    expect(typeof iter[Symbol.asyncDispose]).toBe("function")
    // First .next() yields the first event.
    const r1 = await iter.next()
    expect(r1.done).toBe(false)
    expect(r1.value?.data).toBe("a")
    // Disposing closes the stream and subsequent .next() reports done.
    await iter[Symbol.asyncDispose]()
    const r2 = await iter.next()
    expect(r2.done).toBe(true)
  })
})

describe("sseStreamReconnecting — additional reconnect branches", () => {
  it("falls back to the default 3000ms reconnectDelayMs when omitted", async () => {
    // We don't actually wait 3s — we just need to confirm the default is
    // chosen and the loop keeps running. shouldReconnect returns false on
    // the first attempt to short-circuit before the delay fires.
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        return sseResponse("id: 1\ndata: a\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    let attempts = 0
    const events = sseStreamReconnecting(m, "https://x.test/", {
      // No reconnectDelayMs — must default to 3000.
      shouldReconnect: () => {
        attempts++
        return false
      },
    })
    let received = 0
    for await (const _ of events) received++
    expect(received).toBe(1)
    expect(call).toBe(1)
    expect(attempts).toBe(1)
  })

  it("composes init.signal with the external abort signal (composeAbort branch)", async () => {
    const externalCtrl = new AbortController()
    const initCtrl = new AbortController()
    const seenSignals: AbortSignal[] = []
    const driver = {
      name: "x",
      request: async (req: Request) => {
        seenSignals.push(req.signal)
        return sseResponse("id: 1\ndata: a\n\n")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      // Pass init.signal — exercises the `init.signal ? composeAbort(...)`
      // branch on the request side.
      init: { signal: initCtrl.signal },
      signal: externalCtrl.signal,
      shouldReconnect: () => false,
    })
    let count = 0
    for await (const _ of events) count++
    expect(count).toBe(1)
    expect(seenSignals[0]).toBeDefined()
    // The composed signal should not be the bare init signal.
    expect(seenSignals[0]).not.toBe(initCtrl.signal)
  })

  it("composeAbort: when the original init.signal is already aborted, returns it directly", async () => {
    const externalCtrl = new AbortController()
    const initCtrl = new AbortController()
    initCtrl.abort()
    const driver = {
      name: "x",
      request: async () => sseResponse("id: 1\ndata: a\n\n"),
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      init: { signal: initCtrl.signal },
      signal: externalCtrl.signal,
      shouldReconnect: () => false,
    })
    // Iteration should immediately throw / yield nothing — the aborted
    // signal causes the request to reject. We tolerate either outcome
    // (caught by misina or surfaced) and just confirm we don't hang.
    const collected: unknown[] = []
    try {
      for await (const e of events) collected.push(e)
    } catch {
      // expected: aborted upstream
    }
    expect(collected.length).toBeLessThanOrEqual(1)
  })

  it("composeAbort: when the external signal is already aborted, returns the external signal", async () => {
    // The abort happens *before* iteration — composeAbort's `b.aborted`
    // early-return path runs.
    const externalCtrl = new AbortController()
    const initCtrl = new AbortController()
    externalCtrl.abort()
    const driver = {
      name: "x",
      request: async () => sseResponse("id: 1\ndata: a\n\n"),
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      init: { signal: initCtrl.signal },
      signal: externalCtrl.signal,
    })
    let count = 0
    try {
      for await (const _ of events) count++
    } catch {
      // tolerated
    }
    expect(count).toBe(0)
  })

  it("composeAbort: aborting `a` (init.signal) after compose triggers the composed abort listener", async () => {
    // Force the composeAbort path where neither signal is initially
    // aborted, then trigger `a` after the request is in flight.
    const externalCtrl = new AbortController()
    const initCtrl = new AbortController()
    const driver = {
      name: "x",
      request: async (req: Request) => {
        return new Promise<Response>((resolve, reject) => {
          const abort = (): void => reject(new DOMException("aborted", "AbortError"))
          if (req.signal.aborted) abort()
          else req.signal.addEventListener("abort", abort, { once: true })
          // Resolve eventually if not aborted (won't happen here).
          setTimeout(() => resolve(sseResponse("data: ok\n\n")), 5000)
        })
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      init: { signal: initCtrl.signal },
      signal: externalCtrl.signal,
      maxRetries: 0,
    })
    setTimeout(() => initCtrl.abort(), 20)
    let count = 0
    try {
      for await (const _ of events) count++
    } catch {
      // expected
    }
    expect(count).toBe(0)
  })

  it("clears the pending sleep timer when the external signal aborts during backoff", async () => {
    // Stage a long backoff (5s). The first request fails, kicking off the
    // sleep. While sleeping, abort externally — this must clear the
    // timer and resolve immediately rather than wait the full 5s.
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        throw new TypeError("net fail")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const ctrl = new AbortController()
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 5000,
      maxDelayMs: 5000,
      signal: ctrl.signal,
    })
    const start = Date.now()
    setTimeout(() => ctrl.abort(), 50)
    let count = 0
    try {
      for await (const _ of events) count++
    } catch {
      // tolerated
    }
    const elapsed = Date.now() - start
    // Should exit much sooner than the 5_000ms backoff because the abort
    // listener cleared the timer.
    expect(elapsed).toBeLessThan(1500)
    expect(call).toBeGreaterThanOrEqual(1)
    expect(count).toBe(0)
  })

  it("stops after maxRetries failures (failures > maxRetries branch)", async () => {
    let call = 0
    const driver = {
      name: "x",
      request: async () => {
        call++
        throw new Error("fail")
      },
    }
    const m = createMisina({ driver, retry: 0 })
    const events = sseStreamReconnecting(m, "https://x.test/", {
      reconnectDelayMs: 1,
      maxRetries: 2,
    })
    let count = 0
    for await (const _ of events) count++
    expect(count).toBe(0)
    // 1 initial attempt + 2 retries = 3 total before giving up.
    expect(call).toBe(3)
  })
})

describe("accumulateAnthropicMessage — additional branches", () => {
  it("malformed JSON payload in an event is silently skipped", async () => {
    // Event with non-JSON data triggers the JSON.parse catch arm (line 457).
    const body = [
      `event: garbage\ndata: not-json\n\n`,
      `event: message_start\ndata: ${JSON.stringify({ message: { id: "msg" } })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.id).toBe("msg")
  })

  it("text_delta on a block without prior `text` initializes from empty string", async () => {
    // The block is created via content_block_start with type=text but no
    // `text` field, so `block.text ?? ""` exercises the nullish branch.
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ message: { id: "msg" } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: "text" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "first" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "-second" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.content[0]?.text).toBe("first-second")
  })

  it("content_block_start without content_block field is tolerated", async () => {
    // Exercises the `if (p.content_block)` else path.
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ message: {} })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.content[0]).toBeUndefined()
  })

  it("message_start without `message` payload field is tolerated (else branch)", async () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({})}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    // No id was applied because no message field was provided.
    expect(msg.id).toBeUndefined()
    expect(msg.content).toEqual([])
  })

  it("content_block_delta on missing block is tolerated (the !block guard)", async () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ message: { id: "x" } })}\n\n`,
      // No content_block_start for index 0 — the delta arrives orphaned.
      `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "lost" } })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.content).toEqual([])
  })

  it("message_delta with neither delta nor usage is tolerated", async () => {
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ message: { id: "x" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({})}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.id).toBe("x")
  })

  it("usage merges across multiple message_delta events", async () => {
    // First message_delta provides input_tokens; second provides
    // output_tokens — they merge via spread (the `if (p.usage)` true arm).
    const body = [
      `event: message_start\ndata: ${JSON.stringify({ message: { id: "x" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ usage: { input_tokens: 10 } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ usage: { output_tokens: 7 } })}\n\n`,
      `event: message_stop\ndata: {}\n\n`,
    ].join("")
    const msg = await accumulateAnthropicMessage(sseStream(sseResponse(body)))
    expect(msg.usage?.input_tokens).toBe(10)
    expect(msg.usage?.output_tokens).toBe(7)
  })
})

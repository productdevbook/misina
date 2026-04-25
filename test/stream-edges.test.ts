import { describe, expect, it } from "vitest"
import { ndjsonStream, sseStream } from "../src/stream/index.ts"

function streamFrom(chunks: (string | Uint8Array)[]): Response {
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
    headers: { "content-type": "text/event-stream" },
  })
}

describe("sseStream — chunk-boundary safety", () => {
  it("event split across two chunks parses correctly", async () => {
    const events: { event: string; data: string }[] = []
    for await (const e of sseStream(streamFrom(["data: hel", "lo\n\n"]))) {
      events.push({ event: e.event, data: e.data })
    }
    expect(events).toEqual([{ event: "message", data: "hello" }])
  })

  it("multiline data field concatenates with \\n separator", async () => {
    const events: string[] = []
    for await (const e of sseStream(streamFrom(["data: line1\ndata: line2\ndata: line3\n\n"]))) {
      events.push(e.data)
    }
    expect(events).toEqual(["line1\nline2\nline3"])
  })

  it("comment lines are skipped", async () => {
    const events: string[] = []
    for await (const e of sseStream(
      streamFrom([": this is a heartbeat\ndata: real\n\n: more comment\ndata: also-real\n\n"]),
    )) {
      events.push(e.data)
    }
    expect(events).toEqual(["real", "also-real"])
  })

  it("custom event name is preserved", async () => {
    const evs: { event: string; data: string }[] = []
    for await (const e of sseStream(streamFrom(["event: progress\ndata: 42\n\n"]))) {
      evs.push({ event: e.event, data: e.data })
    }
    expect(evs).toEqual([{ event: "progress", data: "42" }])
  })

  it("id field passes through; NUL is rejected", async () => {
    const events: { id: string | undefined; data: string }[] = []
    for await (const e of sseStream(
      streamFrom([
        "id: abc\ndata: ok\n\n",
        // The next id contains a literal NUL char (\0) which must be ignored.
        "id: bad\0value\ndata: nope\n\n",
      ]),
    )) {
      events.push({ id: e.id, data: e.data })
    }
    expect(events[0]?.id).toBe("abc")
    // Spec: id with NUL must be ignored — falls back to no id.
    expect(events[1]?.id).toBeUndefined()
  })

  it("retry field accepts only digits", async () => {
    const events: { retry: number | undefined }[] = []
    for await (const e of sseStream(
      streamFrom(["retry: 3000\ndata: a\n\n", "retry: not-a-number\ndata: b\n\n"]),
    )) {
      events.push({ retry: e.retry })
    }
    expect(events[0]?.retry).toBe(3000)
    expect(events[1]?.retry).toBeUndefined()
  })

  it("BOM at the very start of the stream is stripped", async () => {
    // UTF-8 BOM is EF BB BF. Should be stripped from first line.
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const events: string[] = []
    for await (const e of sseStream(streamFrom([bom, "data: ok\n\n"]))) {
      events.push(e.data)
    }
    expect(events).toEqual(["ok"])
  })

  it("trailing event without blank line is flushed when stream ends", async () => {
    const events: string[] = []
    for await (const e of sseStream(streamFrom(["data: trailing"]))) {
      events.push(e.data)
    }
    expect(events).toEqual(["trailing"])
  })

  it("CRLF line endings are handled", async () => {
    const events: string[] = []
    for await (const e of sseStream(streamFrom(["data: a\r\ndata: b\r\n\r\n"]))) {
      events.push(e.data)
    }
    expect(events).toEqual(["a\nb"])
  })

  it("breaking out of for-await cancels the underlying stream", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\ndata: b\n\n"))
        // Don't close — let the consumer break early.
      },
      cancel() {
        cancelled = true
      },
    })
    const response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })

    const events: string[] = []
    for await (const e of sseStream(response)) {
      events.push(e.data)
      if (events.length === 1) break
    }
    expect(events).toEqual(["a"])
    expect(cancelled).toBe(true)
  })
})

describe("ndjsonStream — line policy", () => {
  it("empty lines are skipped without erroring", async () => {
    const items: number[] = []
    const r = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"n":1}\n\n{"n":2}\n\n\n{"n":3}\n'))
          controller.close()
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    )
    for await (const obj of ndjsonStream<{ n: number }>(r)) {
      items.push(obj.n)
    }
    expect(items).toEqual([1, 2, 3])
  })

  it("malformed line throws — iterator stops", async () => {
    const r = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":1}\n{garbage}\n{"ok":2}\n'))
          controller.close()
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    )

    const items: { ok: number }[] = []
    await expect(
      (async () => {
        for await (const obj of ndjsonStream<{ ok: number }>(r)) {
          items.push(obj)
        }
      })(),
    ).rejects.toThrow()

    expect(items).toEqual([{ ok: 1 }])
  })

  it("split JSON object across chunks parses correctly", async () => {
    const r = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"n":'))
          controller.enqueue(new TextEncoder().encode("42}\n"))
          controller.close()
        },
      }),
      { headers: { "content-type": "application/x-ndjson" } },
    )

    const items: { n: number }[] = []
    for await (const obj of ndjsonStream<{ n: number }>(r)) {
      items.push(obj)
    }
    expect(items).toEqual([{ n: 42 }])
  })
})

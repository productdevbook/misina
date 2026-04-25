/**
 * Streaming helpers — turn a `Response` body into typed async iterables.
 *
 * - `sseStream(response)`: parse `text/event-stream` events.
 * - `ndjsonStream(response)`: parse `application/x-ndjson` line-delimited JSON.
 * - `linesOf(response)`: raw line iterator (delimited by \n).
 */

export interface SseEvent {
  /** Event id (from `id:` field). */
  id?: string
  /** Event name (from `event:` field). Default: `'message'`. */
  event: string
  /** Concatenated `data:` payload. */
  data: string
  /** Retry hint in milliseconds (from `retry:` field). */
  retry?: number
}

/**
 * Async-iterate Server-Sent Events from a Response with `text/event-stream`.
 * Closing the iterator cancels the underlying stream.
 *
 * Implements the WHATWG HTML EventStream parser (HTML §9.2):
 * - UTF-8 BOM at the start of the stream is stripped.
 * - Lines starting with `:` are comments and ignored.
 * - Empty `event:` field resets to the default `'message'`.
 * - `id:` containing NUL is ignored per spec.
 * - Events are yielded on a blank line; trailing buffer flushed on stream end.
 */
export async function* sseStream(response: Response): AsyncIterable<SseEvent> {
  const body = response.body
  if (!body) return

  let event: SseEvent = { event: "message", data: "" }
  let dataLines: string[] = []
  let firstLine = true

  for await (let line of linesOf(response)) {
    if (firstLine) {
      // Strip leading BOM if present (HTML §9.2.5).
      if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)
      firstLine = false
    }

    if (line === "") {
      if (dataLines.length > 0 || event.id != null || event.retry != null) {
        event.data = dataLines.join("\n")
        yield event
      }
      event = { event: "message", data: "" }
      dataLines = []
      continue
    }
    if (line.startsWith(":")) continue // comment

    const colonAt = line.indexOf(":")
    const field = colonAt === -1 ? line : line.slice(0, colonAt)
    let value = colonAt === -1 ? "" : line.slice(colonAt + 1)
    if (value.startsWith(" ")) value = value.slice(1)

    switch (field) {
      case "event":
        // Empty event field falls back to the default per spec.
        event.event = value === "" ? "message" : value
        break
      case "data":
        dataLines.push(value)
        break
      case "id":
        // HTML §9.2.6 step 9: ignore id with NUL.
        if (!value.includes("\0")) event.id = value
        break
      case "retry": {
        // HTML §9.2.6 step 10: only accept ASCII-digit-only values.
        if (/^\d+$/.test(value)) event.retry = Number(value)
        break
      }
    }
  }

  // Flush any pending event without trailing blank line
  if (dataLines.length > 0) {
    event.data = dataLines.join("\n")
    yield event
  }
}

/**
 * Async-iterate NDJSON / JSON Lines from a Response. Each non-empty line is
 * `JSON.parse`'d. Errors propagate; iterator closes on first parse failure.
 */
export async function* ndjsonStream<T = unknown>(response: Response): AsyncIterable<T> {
  for await (const line of linesOf(response)) {
    if (line === "") continue
    yield JSON.parse(line) as T
  }
}

/**
 * Async-iterate raw lines from a Response body. Splits on `\n`; strips
 * trailing `\r`. Decodes as UTF-8.
 */
export async function* linesOf(response: Response): AsyncIterable<string> {
  const body = response.body
  if (!body) return

  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      let newlineAt = buffer.indexOf("\n")
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        yield line.endsWith("\r") ? line.slice(0, -1) : line
        newlineAt = buffer.indexOf("\n")
      }
    }
    if (buffer) yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer
  } finally {
    reader.releaseLock()
    // Ensure underlying stream is cancelled if iterator was abandoned early.
    try {
      await body.cancel()
    } catch {
      // already closed
    }
  }
}

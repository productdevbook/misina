/**
 * Streaming helpers — turn a `Response` body into typed async iterables.
 *
 * - `sseStream(response)`: parse `text/event-stream` events.
 * - `sseStreamReconnecting(misina, path, opts)`: SSE iterator that
 *   reopens the underlying request on disconnect with `Last-Event-ID`
 *   set to the last `id:` seen and a delay derived from the server's
 *   `retry:` field (or backoff fallback).
 * - `ndjsonStream(response)`: parse `application/x-ndjson` line-delimited JSON.
 * - `linesOf(response)`: raw line iterator (delimited by \n).
 *
 * All four iterators implement `[Symbol.asyncDispose]` so TC39
 * explicit resource management (`await using`) works across runtime
 * baselines. AsyncGenerator's prototype only got native dispose in
 * Node 24; we ensure-disposable any iterable for Node 22 / Bun / Deno.
 */

import type { Misina, MisinaRequestInit } from "../types.ts"

/**
 * Wrap an AsyncIterable so it implements `[Symbol.asyncDispose]` even
 * on runtimes where the AsyncGenerator prototype lacks it (Node 22 LTS).
 * Calls `iter.return()` on dispose, which is the spec-correct close
 * for an active generator.
 */
function ensureDisposable<T>(iter: AsyncIterable<T>): AsyncIterableIterator<T> & AsyncDisposable {
  const inner = (
    iter as AsyncIterable<T> & {
      [Symbol.asyncIterator](): AsyncIterableIterator<T>
    }
  )[Symbol.asyncIterator]()
  // If the runtime already provides asyncDispose, re-export the iterator
  // unchanged so behavior is identical to the native path.
  if (typeof (inner as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose] === "function") {
    return inner as AsyncIterableIterator<T> & AsyncDisposable
  }
  const wrapped: AsyncIterableIterator<T> & AsyncDisposable = {
    next: inner.next.bind(inner) as AsyncIterableIterator<T>["next"],
    return: inner.return ? inner.return.bind(inner) : undefined,
    throw: inner.throw ? inner.throw.bind(inner) : undefined,
    [Symbol.asyncIterator](): AsyncIterableIterator<T> & AsyncDisposable {
      return wrapped
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await inner.return?.(undefined as unknown as T)
    },
  }
  return wrapped
}

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
export function sseStream(response: Response): AsyncIterableIterator<SseEvent> & AsyncDisposable {
  return ensureDisposable(_sseStream(response))
}

async function* _sseStream(response: Response): AsyncIterable<SseEvent> {
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

export interface SseReconnectOptions {
  /** Per-request init forwarded to `misina.get(path, init)`. */
  init?: MisinaRequestInit
  /**
   * Fallback delay between reconnect attempts when the server hasn't
   * sent a `retry:` field yet. Default: 3000 ms (HTML §9.2.4 default).
   */
  reconnectDelayMs?: number
  /**
   * Max delay between reconnect attempts. The effective delay is
   * `min(serverRetry || reconnectDelayMs * 2^failures, max)`.
   * Default: 60_000 ms.
   */
  maxDelayMs?: number
  /**
   * Stop reconnecting after this many consecutive failures. Default:
   * Infinity — reconnect forever until disposed or signal aborts.
   */
  maxRetries?: number
  /**
   * Decide whether to keep reconnecting. Receives the failure that
   * closed the previous connection (Error or undefined for graceful
   * EOF) and the current failure count. Return false to stop.
   * Default: always reconnect.
   */
  shouldReconnect?: (error: unknown, attempt: number) => boolean
  /** External abort signal — disposes the iterator when fired. */
  signal?: AbortSignal
}

/**
 * SSE iterator that reopens the connection across disconnects, honoring
 * the server's `retry:` field and `Last-Event-ID` header (HTML §9.2.4).
 *
 * Each iteration yields the events from the *current* connection; when
 * the source closes (graceful EOF or stream error) we sleep for the
 * effective retry delay then reissue the request with `Last-Event-ID`
 * set to the most recently seen `id:` value.
 *
 * Dispose (`await using` or `signal.abort()`) cancels the in-flight
 * connection and stops the reconnect loop.
 *
 * @example
 * ```ts
 * const events = sseStreamReconnecting(api, "/v1/notifications", {
 *   reconnectDelayMs: 1000,
 * })
 * for await (const e of events) console.log(e)
 * ```
 */
export function sseStreamReconnecting(
  misina: Misina,
  path: string,
  options: SseReconnectOptions = {},
): AsyncIterableIterator<SseEvent> & AsyncDisposable {
  return ensureDisposable(_sseStreamReconnecting(misina, path, options))
}

async function* _sseStreamReconnecting(
  misina: Misina,
  path: string,
  options: SseReconnectOptions,
): AsyncIterable<SseEvent> {
  const fallbackDelay = options.reconnectDelayMs ?? 3000
  const maxDelay = options.maxDelayMs ?? 60_000
  const maxRetries = options.maxRetries ?? Infinity
  const shouldReconnect = options.shouldReconnect ?? (() => true)
  const externalSignal = options.signal

  let lastEventId: string | undefined
  let serverRetryMs: number | undefined
  let failures = 0

  while (true) {
    if (externalSignal?.aborted) return
    const init: MisinaRequestInit = { ...options.init, responseType: "stream" }
    const headers = new Headers(init.headers as HeadersInit | undefined)
    headers.set("accept", headers.get("accept") ?? "text/event-stream")
    if (lastEventId !== undefined) headers.set("last-event-id", lastEventId)
    init.headers = headers
    if (externalSignal) {
      init.signal = init.signal ? composeAbort(init.signal, externalSignal) : externalSignal
    }

    let lastError: unknown = undefined
    try {
      const result = await misina.get(path, init)
      // Reset failure count on a successful response — backoff applies
      // to *consecutive* failures, not lifetime count.
      failures = 0
      for await (const event of sseStream(result.raw)) {
        if (event.id !== undefined) lastEventId = event.id
        if (event.retry !== undefined) serverRetryMs = event.retry
        yield event
      }
    } catch (error) {
      lastError = error
    }

    if (externalSignal?.aborted) return
    failures++
    if (failures > maxRetries) return
    if (!shouldReconnect(lastError, failures)) return

    const base = serverRetryMs ?? fallbackDelay * 2 ** Math.min(failures - 1, 6)
    const delay = Math.min(base, maxDelay)
    await sleep(delay, externalSignal)
  }
}

function composeAbort(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a
  if (b.aborted) return b
  const c = new AbortController()
  const onAbort = (): void => c.abort()
  a.addEventListener("abort", onAbort, { once: true })
  b.addEventListener("abort", onAbort, { once: true })
  return c.signal
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * Async-iterate NDJSON / JSON Lines from a Response. Each non-empty line is
 * `JSON.parse`'d. Errors propagate; iterator closes on first parse failure.
 */
export function ndjsonStream<T = unknown>(
  response: Response,
): AsyncIterableIterator<T> & AsyncDisposable {
  return ensureDisposable(_ndjsonStream<T>(response))
}

async function* _ndjsonStream<T = unknown>(response: Response): AsyncIterable<T> {
  for await (const line of linesOf(response)) {
    if (line === "") continue
    yield JSON.parse(line) as T
  }
}

/**
 * Async-iterate raw lines from a Response body. Splits on `\n`; strips
 * trailing `\r`. Decodes as UTF-8.
 */
export function linesOf(response: Response): AsyncIterableIterator<string> & AsyncDisposable {
  return ensureDisposable(_linesOf(response))
}

async function* _linesOf(response: Response): AsyncIterable<string> {
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
    // Cancel through the reader so the cancel signal traverses the
    // pipeThrough(TextDecoderStream) chain back to the source body. Just
    // releasing the lock and calling body.cancel() doesn't reach the source
    // in some runtimes, so the consumer's source.cancel() never fires.
    try {
      await reader.cancel()
    } catch {
      // already closed
    }
    reader.releaseLock()
  }
}

/**
 * Generic stream consumer with reducer. Drains the iterable and folds
 * each chunk into a running accumulator, returning the final value.
 *
 * Mirrors `Array.prototype.reduce` for async iterables. Useful as the
 * building block for provider-specific accumulators below.
 */
export async function collect<TIn, TOut>(
  source: AsyncIterable<TIn>,
  reducer: (acc: TOut, chunk: TIn) => TOut | Promise<TOut>,
  initial: TOut,
): Promise<TOut> {
  let acc = initial
  for await (const chunk of source) {
    acc = await reducer(acc, chunk)
  }
  return acc
}

/**
 * OpenAI Chat Completions streaming format. The model emits SSE events
 * with `data: { ... }` payloads carrying `choices[].delta` increments.
 * Tool calls arrive as partial deltas indexed by `index`; `function.name`
 * is set on the first delta and `function.arguments` is concatenated
 * across subsequent deltas.
 */
export interface OpenAIToolCall {
  id?: string
  type?: "function"
  function: { name?: string; arguments: string }
}

/**
 * Drain an OpenAI chat-completion SSE stream and return the accumulated
 * tool calls. Stops at the `[DONE]` sentinel. JSON parse errors and
 * non-tool-call deltas are tolerated silently — telemetry shouldn't break
 * the stream.
 *
 * @example
 * ```ts
 * const res = await api.post('/v1/chat/completions', body, { responseType: 'stream' })
 * const calls = await accumulateOpenAIToolCalls(sseStream(res.raw))
 * ```
 */
export async function accumulateOpenAIToolCalls(
  events: AsyncIterable<SseEvent>,
): Promise<OpenAIToolCall[]> {
  const byIndex: OpenAIToolCall[] = []
  for await (const event of events) {
    if (event.data === "[DONE]") break
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch {
      continue
    }
    const choice = (parsed as { choices?: Array<{ delta?: unknown }> }).choices?.[0]
    const delta = choice?.delta as
      | {
          tool_calls?: Array<{
            index: number
            id?: string
            type?: "function"
            function?: { name?: string; arguments?: string }
          }>
        }
      | undefined
    if (!delta?.tool_calls) continue
    for (const tc of delta.tool_calls) {
      const slot = (byIndex[tc.index] ??= { function: { arguments: "" } })
      if (tc.id) slot.id = tc.id
      if (tc.type) slot.type = tc.type
      if (tc.function?.name) slot.function.name = tc.function.name
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
    }
  }
  return byIndex
}

/**
 * Anthropic Messages streaming format. Named events carry typed payloads:
 * `message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`. Content blocks
 * may be `text` (concatenate `text_delta.text`) or `tool_use`
 * (concatenate `input_json_delta.partial_json` then JSON.parse at end).
 */
export interface AnthropicContentBlock {
  type: "text" | "tool_use" | string
  text?: string
  id?: string
  name?: string
  input?: unknown
  /** Raw partial-JSON for tool_use; populated until content_block_stop. */
  partial_json?: string
}

export interface AnthropicAccumulatedMessage {
  id?: string
  model?: string
  role?: string
  content: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Drain an Anthropic Messages SSE stream and return the accumulated
 * message. Closes at `message_stop`. Tool-use partial JSON is
 * concatenated and parsed on `content_block_stop`; if parsing fails the
 * raw `partial_json` stays accessible.
 *
 * @example
 * ```ts
 * const res = await api.post('/v1/messages', body, { responseType: 'stream' })
 * const message = await accumulateAnthropicMessage(sseStream(res.raw))
 * ```
 */
export async function accumulateAnthropicMessage(
  events: AsyncIterable<SseEvent>,
): Promise<AnthropicAccumulatedMessage> {
  const message: AnthropicAccumulatedMessage = { content: [] }
  for await (const event of events) {
    let payload: unknown
    try {
      payload = JSON.parse(event.data)
    } catch {
      continue
    }
    const ev = event.event
    if (ev === "message_start") {
      const m = (payload as { message?: Partial<AnthropicAccumulatedMessage> }).message
      if (m) Object.assign(message, m, { content: [] })
      continue
    }
    if (ev === "content_block_start") {
      const p = payload as { index: number; content_block?: AnthropicContentBlock }
      if (p.content_block) message.content[p.index] = { ...p.content_block }
      continue
    }
    if (ev === "content_block_delta") {
      const p = payload as {
        index: number
        delta?: { type?: string; text?: string; partial_json?: string }
      }
      const block = message.content[p.index]
      if (!block || !p.delta) continue
      if (p.delta.type === "text_delta" && p.delta.text) {
        block.text = (block.text ?? "") + p.delta.text
      } else if (p.delta.type === "input_json_delta" && p.delta.partial_json !== undefined) {
        block.partial_json = (block.partial_json ?? "") + p.delta.partial_json
      }
      continue
    }
    if (ev === "content_block_stop") {
      const p = payload as { index: number }
      const block = message.content[p.index]
      if (block?.partial_json !== undefined && block.input === undefined) {
        try {
          block.input = JSON.parse(block.partial_json)
        } catch {
          // leave partial_json intact for caller inspection
        }
      }
      continue
    }
    if (ev === "message_delta") {
      const p = payload as {
        delta?: Partial<AnthropicAccumulatedMessage>
        usage?: AnthropicAccumulatedMessage["usage"]
      }
      if (p.delta) Object.assign(message, p.delta)
      if (p.usage) message.usage = { ...message.usage, ...p.usage }
      continue
    }
    if (ev === "message_stop") break
  }
  return message
}

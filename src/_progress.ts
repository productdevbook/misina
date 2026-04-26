import type { ProgressCallback } from "./types.ts"

const CHUNK_SIZE = 64 * 1024

/**
 * Wrap a `BodyInit` so each emitted chunk fires a progress event. Total
 * size is computed when the body is a string, ArrayBuffer/ArrayBufferView,
 * or Blob; otherwise total is undefined.
 *
 * Returns a `ReadableStream` plus the computed total. When streams aren't
 * supported (no duplex), the caller should fall back to passing the body
 * directly without progress events.
 */
export async function progressUpload(
  body: BodyInit,
  callback: ProgressCallback,
  intervalMs = 0,
): Promise<{ body: BodyInit; total: number | undefined }> {
  const { bytes, total } = await materializeBody(body)
  if (!bytes) {
    // Stream/FormData/etc. — pass through without progress
    return { body, total: undefined }
  }

  const stream = chunkifyToProgressStream(
    bytes,
    total ?? bytes.byteLength,
    throttle(callback, intervalMs),
  )
  return { body: stream, total: total ?? bytes.byteLength }
}

function throttle(callback: ProgressCallback, intervalMs: number): ProgressCallback {
  if (intervalMs <= 0) return callback
  let last = 0
  return (event) => {
    const now = Date.now()
    // Always emit the final 100% event regardless of throttle.
    if (event.percent === 1 || now - last >= intervalMs) {
      last = now
      callback(event)
    }
  }
}

async function materializeBody(
  body: BodyInit,
): Promise<{ bytes: Uint8Array | undefined; total: number | undefined }> {
  if (typeof body === "string") {
    const bytes = new TextEncoder().encode(body)
    return { bytes, total: bytes.byteLength }
  }
  if (body instanceof Uint8Array) return { bytes: body, total: body.byteLength }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body)
    return { bytes, total: bytes.byteLength }
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    return { bytes, total: bytes.byteLength }
  }
  if (body instanceof Blob) {
    const buf = await body.arrayBuffer()
    const bytes = new Uint8Array(buf)
    return { bytes, total: bytes.byteLength }
  }
  return { bytes: undefined, total: undefined }
}

function chunkifyToProgressStream(
  bytes: Uint8Array,
  total: number,
  callback: ProgressCallback,
): ReadableStream<Uint8Array> {
  let offset = 0
  const start = Date.now()

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength)
      const chunk = bytes.subarray(offset, end)
      offset = end
      controller.enqueue(chunk)

      const elapsed = (Date.now() - start) / 1000
      callback({
        loaded: offset,
        total,
        percent: total ? offset / total : 0,
        bytesPerSecond: elapsed > 0 ? offset / elapsed : 0,
      })
    },
  })
}

/**
 * Wrap a Response so iterating its body fires progress events. Returns a
 * new Response with the wrapped stream; consume it like any other Response.
 */
export function progressDownload(
  response: Response,
  callback: ProgressCallback,
  intervalMs = 0,
): Response {
  const body = response.body
  if (!body) return response

  const totalHeader = response.headers.get("content-length")
  const total = totalHeader ? Number(totalHeader) : undefined
  const start = Date.now()
  let loaded = 0
  const emit = throttle(callback, intervalMs)

  const wrapped = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          loaded += value.byteLength
          controller.enqueue(value)

          const elapsed = (Date.now() - start) / 1000
          emit({
            loaded,
            total: total != null && Number.isFinite(total) ? total : undefined,
            percent: total ? loaded / total : 0,
            bytesPerSecond: elapsed > 0 ? loaded / elapsed : 0,
          })
        }
        controller.close()
      } catch (err) {
        controller.error(err)
        // Release the upstream stream too so the underlying connection can be
        // freed instead of waiting on a never-consumed body.
        reader.releaseLock()
        try {
          await body.cancel()
        } catch {
          // already cancelled / closed
        }
        return
      }
      reader.releaseLock()
    },
    cancel(reason) {
      // Caller cancelled the iterator — propagate to the upstream stream.
      return body.cancel(reason)
    },
  })

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Whether the runtime supports half-duplex streamed request bodies. */
export function supportsRequestStreams(): boolean {
  try {
    let supports = false
    new Request("data:,", {
      method: "POST",
      body: new ReadableStream(),
      // duplex is required when streaming a request body
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    supports = true
    return supports
  } catch {
    return false
  }
}

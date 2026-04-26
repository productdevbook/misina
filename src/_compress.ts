/**
 * Opt-in request body compression. Wraps an outgoing body in a
 * `CompressionStream` so the wire payload is smaller and the server
 * sees the matching `Content-Encoding` header.
 *
 * `CompressionStream` is supported on Node 22+, Bun, Deno, and Baseline
 * 2024 browsers — but only for `gzip`, `deflate`, and `deflate-raw`.
 * `br` / `zstd` are not in the WHATWG Compression Streams spec; we
 * capability-test before encoding and refuse silently if a requested
 * format isn't available.
 */

export type CompressFormat = "gzip" | "deflate" | "deflate-raw"

const ALL_FORMATS: CompressFormat[] = ["gzip", "deflate", "deflate-raw"]

/**
 * Resolve the user's `compressRequestBody` option to a concrete format,
 * or null if compression should be skipped.
 *
 * - `false` / `undefined`: skip.
 * - `true`: pick the first runtime-supported format, preferring `gzip`.
 * - A specific format string: only used when supported on this runtime.
 */
export function resolveCompressFormat(
  option: boolean | CompressFormat | undefined,
): CompressFormat | null {
  if (!option) return null
  if (typeof CompressionStream !== "function") return null
  const candidates = option === true ? ALL_FORMATS : [option]
  for (const fmt of candidates) {
    try {
      // Constructor throws on unsupported formats.
      new CompressionStream(fmt as never)
      return fmt
    } catch {
      // try next
    }
  }
  return null
}

/**
 * Wrap a body source in a `CompressionStream`. Returns a tuple of the
 * compressed `ReadableStream<Uint8Array>` and the matching
 * `Content-Encoding` value the caller should set on the request.
 *
 * - `string` and `Uint8Array` bodies are encoded into a one-shot
 *   ReadableStream then piped through.
 * - Existing `ReadableStream` bodies are piped through directly.
 * - `null` / `undefined` skips entirely (caller falls back to the
 *   original empty body).
 */
export function compressBody(
  body: BodyInit | null | undefined,
  format: CompressFormat,
): { stream: ReadableStream<Uint8Array>; encoding: CompressFormat } | null {
  if (body == null) return null

  let source: ReadableStream<Uint8Array>
  if (typeof body === "string") {
    const bytes = new TextEncoder().encode(body)
    source = singleChunkStream(bytes)
  } else if (body instanceof Uint8Array) {
    source = singleChunkStream(body)
  } else if (body instanceof ArrayBuffer) {
    source = singleChunkStream(new Uint8Array(body))
  } else if (body instanceof ReadableStream) {
    source = body as ReadableStream<Uint8Array>
  } else {
    // FormData / Blob / URLSearchParams: skip — the boundary / encoding
    // contract is owned by the caller and zipping the wire bytes would
    // break multipart parsing on the server side.
    return null
  }

  // Cast: lib.dom types CompressionStream as `ReadableWritablePair<Uint8Array, BufferSource>`
  // but pipeThrough expects identical generic args. We know the runtime
  // accepts Uint8Array writes either way.
  const transform = new CompressionStream(format as never) as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  const stream = source.pipeThrough(transform)
  return { stream, encoding: format }
}

function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

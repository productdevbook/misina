/**
 * Build a `File` from any byte-bearing source. Useful for multipart
 * uploads (vision, audio, files endpoints) where the source might be a
 * string, Uint8Array, ArrayBuffer, Blob, ReadableStream, or async
 * iterable (Node fs.ReadStream, generators, etc.).
 *
 * The result is a real `File` with a working `arrayBuffer()` /
 * `stream()` / `text()` so it can be appended to FormData and read by
 * fetch implementations across runtimes.
 */

export type FileSource =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>

export interface ToFileOptions {
  /** MIME type. Default: 'application/octet-stream'. */
  type?: string
  /** lastModified epoch ms. Default: now. */
  lastModified?: number
}

export async function toFile(
  name: string,
  source: FileSource,
  options: ToFileOptions = {},
): Promise<File> {
  const type = options.type ?? "application/octet-stream"
  const lastModified = options.lastModified ?? Date.now()
  const parts: BlobPart[] = []

  if (typeof source === "string") {
    parts.push(source)
  } else if (source instanceof Blob) {
    parts.push(source)
  } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    parts.push(source as BlobPart)
  } else if (source instanceof ReadableStream) {
    for (const chunk of await collectStream(source)) {
      parts.push(chunk as unknown as BlobPart)
    }
  } else if (Symbol.asyncIterator in source) {
    for await (const chunk of source) {
      parts.push(chunk as unknown as BlobPart)
    }
  } else {
    throw new TypeError(`misina: toFile got an unsupported source type for ${name}`)
  }

  return new File(parts, name, { type, lastModified })
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return chunks
}

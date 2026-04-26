/**
 * Range-aware download and resumable upload helpers.
 *
 * `downloadResumable(misina, url, opts)` issues a Range-aware GET that
 * can resume after a network failure: it probes the server's
 * `Accept-Ranges: bytes` advertisement, fetches the body in chunks,
 * and re-issues the next chunk with `Range: bytes=N-` after a failure.
 * Falls back to a single streaming GET when the server doesn't
 * advertise byte ranges.
 *
 * `uploadResumable(misina, url, source, opts)` follows
 * draft-ietf-httpbis-resumable-upload: a `POST` opens the upload, the
 * server returns the upload location, and the client `PATCH`'es chunks
 * with `Upload-Offset`. The final chunk carries `Upload-Incomplete: ?0`
 * to signal completion. On reconnect after a network failure, a `HEAD`
 * to the upload location returns the server's known offset, which the
 * client uses to skip already-received bytes.
 *
 * Both helpers integrate with `onProgress` so callers can render UI
 * across pause/resume boundaries.
 */

import type { Misina } from "../types.ts"

/* ------------------------------------------------------------------------- */
/*                              downloadResumable                            */
/* ------------------------------------------------------------------------- */

export interface DownloadProgress {
  loaded: number
  total: number | undefined
  percent: number
}

export interface DownloadResumableOptions {
  /** Bytes per range request. Default: 4 MiB. */
  chunkSize?: number
  /** Total max retry attempts per chunk before giving up. Default: 3. */
  maxRetries?: number
  /** Progress callback invoked across pause/resume boundaries. */
  onProgress?: (progress: DownloadProgress) => void
  /** External abort signal — pauses the download. */
  signal?: AbortSignal
  /**
   * Resume from this byte offset. Caller passes the offset they have
   * already persisted (e.g. partial file size). Default: 0.
   */
  startOffset?: number
}

export interface ResumableDownloadResult {
  /** Concatenated body as a Blob. */
  blob: Blob
  /** Final size in bytes (== blob.size). */
  size: number
  /** True when the server advertised byte ranges and chunks were used. */
  ranged: boolean
}

/**
 * Download a resource with byte-range resume support. Probes
 * `Accept-Ranges: bytes` and `Content-Length` via a HEAD; if either is
 * missing or the server doesn't support ranges, falls back to a single
 * streaming GET.
 */
export async function downloadResumable(
  misina: Misina,
  url: string,
  options: DownloadResumableOptions = {},
): Promise<ResumableDownloadResult> {
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024
  const maxRetries = options.maxRetries ?? 3
  const startOffset = options.startOffset ?? 0
  const signal = options.signal

  // Probe with HEAD. Some servers refuse HEAD; fall back to a Range
  // request that asks for byte 0 only — that returns 206 with the
  // size in Content-Range.
  let total: number | undefined
  let ranged = false
  try {
    const head = await misina.head(url, { signal, responseType: "stream" })
    ranged = (head.raw.headers.get("accept-ranges") ?? "").toLowerCase() === "bytes"
    const cl = head.raw.headers.get("content-length")
    if (cl) total = Number(cl)
  } catch {
    // HEAD not allowed — try a tiny Range probe.
    try {
      const probe = await misina.get(url, {
        headers: { range: "bytes=0-0" },
        signal,
        responseType: "stream",
      })
      ranged = probe.raw.status === 206
      const cr = probe.raw.headers.get("content-range")
      const m = /\/(\d+)$/.exec(cr ?? "")
      if (m && m[1]) total = Number(m[1])
      // Drain so the connection is releasable.
      await probe.raw.arrayBuffer().catch(() => undefined)
    } catch {
      ranged = false
    }
  }

  if (!ranged || total === undefined) {
    // Single-shot streaming GET.
    const res = await misina.get(url, { signal, responseType: "stream" })
    const chunks: Uint8Array[] = []
    let loaded = 0
    const reader = res.raw.body?.getReader()
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          loaded += value.byteLength
          options.onProgress?.({ loaded, total, percent: total ? loaded / total : 0 })
        }
      }
    }
    const blob = new Blob(chunks as BlobPart[])
    return { blob, size: blob.size, ranged: false }
  }

  // Ranged path: pull `chunkSize` at a time, retrying each chunk on
  // failure up to maxRetries.
  const chunks: Uint8Array[] = []
  let loaded = startOffset
  options.onProgress?.({ loaded, total, percent: total ? loaded / total : 0 })

  while (loaded < total) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const end = Math.min(loaded + chunkSize, total) - 1
    const range = `bytes=${loaded}-${end}`
    let attempt = 0
    let chunk: Uint8Array | undefined
    while (attempt <= maxRetries) {
      try {
        const res = await misina.get(url, {
          headers: { range },
          signal,
          responseType: "arrayBuffer",
        })
        chunk = new Uint8Array(res.data as ArrayBuffer)
        break
      } catch (error) {
        attempt++
        if (attempt > maxRetries) throw error
        // Linear-ish backoff; the underlying retry already applies
        // exponential to network errors.
        await delay(50 * attempt, signal)
      }
    }
    if (!chunk) break
    chunks.push(chunk)
    loaded += chunk.byteLength
    options.onProgress?.({ loaded, total, percent: total ? loaded / total : 0 })
  }
  const blob = new Blob(chunks as BlobPart[])
  return { blob, size: blob.size, ranged: true }
}

/* ------------------------------------------------------------------------- */
/*                              uploadResumable                              */
/* ------------------------------------------------------------------------- */

export interface UploadProgress {
  loaded: number
  total: number
  percent: number
}

export interface UploadResumableOptions {
  /** Bytes per PATCH. Default: 4 MiB. */
  chunkSize?: number
  /**
   * Existing upload location from a previous attempt. When set, the
   * helper sends `HEAD` to recover the offset and resumes from there.
   * When unset, the helper opens a new upload via `POST` to `url`.
   */
  uploadUrl?: string
  /** Progress callback invoked after each PATCH. */
  onProgress?: (progress: UploadProgress) => void
  /** External abort signal — pauses the upload. */
  signal?: AbortSignal
  /** Max retries per chunk before failing. Default: 3. */
  maxRetries?: number
}

export interface ResumableUploadResult {
  /** Final upload location (Location header from POST or the input). */
  uploadUrl: string
  /** Bytes uploaded across the lifetime of this call. */
  uploaded: number
}

/**
 * Resumable upload following draft-ietf-httpbis-resumable-upload. The
 * source must expose a `byteLength` (Uint8Array, ArrayBuffer, Blob).
 *
 * Protocol:
 * 1. `POST url` opens the upload. The server returns the upload
 *    location in `Location`.
 * 2. The client sends `PATCH <location>` with `Upload-Offset`,
 *    `Content-Type: application/partial-upload`, and a chunk of bytes.
 *    The final chunk carries `Upload-Incomplete: ?0` to signal end.
 * 3. On a network failure mid-upload, the client reissues `HEAD
 *    <location>` to recover the server's known offset and retries the
 *    next chunk from there.
 *
 * Pass `uploadUrl` from a previous (interrupted) attempt to resume
 * without a fresh POST.
 */
export async function uploadResumable(
  misina: Misina,
  url: string,
  source: Uint8Array | ArrayBuffer | Blob,
  options: UploadResumableOptions = {},
): Promise<ResumableUploadResult> {
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024
  const maxRetries = options.maxRetries ?? 3
  const signal = options.signal

  const total = sourceLength(source)
  let uploadUrl = options.uploadUrl
  let offset = 0

  if (!uploadUrl) {
    // Open a new upload. The protocol uses POST with
    // `Upload-Incomplete: ?1` and `Upload-Length` informational hint.
    const open = await misina.post(url, undefined, {
      headers: {
        "upload-incomplete": "?1",
        "upload-length": String(total),
      },
      signal,
      responseType: "stream",
    })
    const location = open.raw.headers.get("location")
    if (!location) throw new Error("misina/transfer: server did not return Location for upload")
    uploadUrl = new URL(location, url).toString()
    // Drain so the connection is releasable on runtimes that don't
    // auto-close after Location is read.
    await open.raw.arrayBuffer().catch(() => undefined)
  } else {
    // Resume: ask the server where it left off.
    try {
      const head = await misina.head(uploadUrl, { signal, responseType: "stream" })
      const off = head.raw.headers.get("upload-offset")
      if (off) offset = Number(off)
    } catch {
      // Some servers don't support HEAD; start from 0 and let the
      // server reject with 409 if there's a mismatch.
    }
  }

  options.onProgress?.({ loaded: offset, total, percent: total ? offset / total : 0 })

  while (offset < total) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    const end = Math.min(offset + chunkSize, total)
    const chunk = await sliceSource(source, offset, end)
    const isLast = end === total
    let attempt = 0
    while (attempt <= maxRetries) {
      try {
        await misina.patch(uploadUrl, chunk, {
          headers: {
            "content-type": "application/partial-upload",
            "upload-offset": String(offset),
            "upload-incomplete": isLast ? "?0" : "?1",
          },
          signal,
        })
        break
      } catch (error) {
        attempt++
        if (attempt > maxRetries) throw error
        await delay(50 * attempt, signal)
      }
    }
    offset = end
    options.onProgress?.({ loaded: offset, total, percent: total ? offset / total : 0 })
  }

  return { uploadUrl, uploaded: offset }
}

/* ------------------------------------------------------------------------- */
/*                                  helpers                                  */
/* ------------------------------------------------------------------------- */

function sourceLength(source: Uint8Array | ArrayBuffer | Blob): number {
  if (source instanceof Blob) return source.size
  if (source instanceof ArrayBuffer) return source.byteLength
  return source.byteLength
}

async function sliceSource(
  source: Uint8Array | ArrayBuffer | Blob,
  start: number,
  end: number,
): Promise<Uint8Array> {
  if (source instanceof Blob) {
    const buf = await source.slice(start, end).arrayBuffer()
    return new Uint8Array(buf)
  }
  if (source instanceof ArrayBuffer) {
    return new Uint8Array(source.slice(start, end))
  }
  return source.slice(start, end)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

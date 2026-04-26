/**
 * Opt-in response decompression. Most runtimes (Node 22+, Bun, Deno) auto-
 * decompress gzip/br responses at the fetch layer; this module exists for
 * formats they don't (zstd, until widely shipped) and for custom drivers
 * that don't decompress at all.
 */

export type DecompressFormat = "gzip" | "deflate" | "deflate-raw" | "br" | "zstd"

const ALL_FORMATS: DecompressFormat[] = ["gzip", "deflate", "deflate-raw", "br", "zstd"]

/**
 * Capability-test which formats the runtime's `DecompressionStream`
 * actually supports. Returns the intersection of the user's request and
 * runtime support.
 */
export function detectSupportedFormats(
  requested: readonly DecompressFormat[] | true,
): DecompressFormat[] {
  if (typeof DecompressionStream !== "function") return []
  const candidates = requested === true ? ALL_FORMATS : requested
  const supported: DecompressFormat[] = []
  for (const fmt of candidates) {
    try {
      // Constructor itself throws on unsupported formats.
      // eslint-disable-next-line no-new
      new DecompressionStream(fmt as never)
      supported.push(fmt)
    } catch {
      // Not supported on this runtime — skip.
    }
  }
  return supported
}

/**
 * Wrap a Response in a DecompressionStream when its `Content-Encoding`
 * matches one of the formats AND the body hasn't already been decoded.
 *
 * Heuristic for "already decoded": if the runtime delivered a decoded
 * response, `Content-Length` typically no longer matches the encoded size
 * and `Content-Encoding` may be stripped. We act conservatively — only
 * decompress when `Content-Encoding` is still present.
 */
export function maybeDecompress(
  response: Response,
  formats: readonly DecompressFormat[],
): Response {
  if (formats.length === 0) return response
  const encoding = response.headers.get("content-encoding")?.toLowerCase()
  if (!encoding) return response
  // Comma-separated list — RFC says outermost wraps innermost. We only
  // handle the simple single-encoding case.
  const fmt = encoding.split(",")[0]?.trim() as DecompressFormat | undefined
  if (!fmt || !formats.includes(fmt)) return response
  const body = response.body
  if (!body) return response

  const decoded = body.pipeThrough(new DecompressionStream(fmt as never))

  // Strip Content-Encoding + Content-Length so downstream callers don't
  // misinterpret the new (decoded) body as still-encoded.
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")

  return new Response(decoded, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Build the `Accept-Encoding` header value from a runtime-supported list.
 * Returns undefined if the list is empty (don't advertise nothing).
 */
export function acceptEncodingFor(formats: readonly DecompressFormat[]): string | undefined {
  if (formats.length === 0) return undefined
  return formats.join(", ")
}

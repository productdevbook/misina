import { ResponseTooLargeError } from "./errors/response_too_large.ts"

/**
 * Enforce `maxResponseSize` on a Response. If `Content-Length` is present
 * and exceeds the cap, throws synchronously (fast path — no bytes read).
 * Otherwise wraps the body in a counting TransformStream that aborts on
 * the first chunk that pushes the running total past the cap.
 */
export function enforceMaxResponseSize(response: Response, limit: number | false): Response {
  if (limit === false) return response
  if (response.body == null) return response

  const length = response.headers.get("content-length")
  if (length !== null) {
    const n = Number(length)
    if (Number.isFinite(n) && n > limit) {
      // Cancel the body stream so the connection can be released.
      response.body.cancel().catch(() => {})
      throw new ResponseTooLargeError(limit, n, "content-length")
    }
  }

  let received = 0
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (received > limit) {
        controller.error(new ResponseTooLargeError(limit, received, "stream"))
        return
      }
      controller.enqueue(chunk)
    },
  })

  return new Response(response.body.pipeThrough(counter), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

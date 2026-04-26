import { MisinaError } from "./base.ts"

/**
 * Thrown when a response body exceeds `maxResponseSize`. May fire pre-stream
 * (Content-Length over the cap) or mid-stream (byte counter exceeded the
 * cap during read). The body stream is aborted before the throw.
 */
export class ResponseTooLargeError extends MisinaError {
  override readonly name = "ResponseTooLargeError"
  readonly limit: number
  readonly received: number
  readonly source: "content-length" | "stream"

  constructor(limit: number, received: number, source: "content-length" | "stream") {
    super(`Response exceeded maxResponseSize: ${received} > ${limit} bytes (${source})`)
    this.limit = limit
    this.received = received
    this.source = source
  }
}

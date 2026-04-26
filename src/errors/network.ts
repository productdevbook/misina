import { MisinaError } from "./base.ts"

export class NetworkError extends MisinaError {
  override readonly name = "NetworkError"
  /**
   * Response object when the network failure happened mid-stream after
   * headers had already arrived. `undefined` for pre-connection failures
   * (DNS, TCP refuse, TLS) where no response was ever produced.
   */
  readonly response: Response | undefined

  constructor(message: string, options?: { cause?: unknown; response?: Response }) {
    super(message, options)
    this.response = options?.response
  }
}

export function isRawNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError") return false
  const message = error.message.toLowerCase()
  return (
    error.name === "TypeError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("socket")
  )
}

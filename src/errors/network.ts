import { MisinaError } from "./base.ts"

/**
 * Thrown when the request fails before a usable response is produced —
 * DNS lookup failure, TCP refuse, TLS handshake error, or a stream cut
 * mid-body after headers arrived. The original cause (e.g. `TypeError:
 * fetch failed`) is preserved on `.cause`; `.response` is populated only
 * for the mid-stream case.
 *
 * @example
 * ```ts
 * import { isNetworkError } from "misina"
 *
 * try { await api.get("/users") } catch (err) {
 *   if (isNetworkError(err)) {
 *     console.warn("upstream unreachable:", err.message)
 *     showOfflineBanner()
 *   } else throw err
 * }
 * ```
 */
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

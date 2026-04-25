import { MisinaError } from "./base.ts"

export class NetworkError extends MisinaError {
  override readonly name = "NetworkError"

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
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

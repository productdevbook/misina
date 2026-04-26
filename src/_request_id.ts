/**
 * Read the server-issued request id from response headers. OpenAI surfaces
 * `x-request-id`, Anthropic uses `request-id`, many gateways use
 * `x-correlation-id` or `cf-ray`. Caller supplies the candidate list.
 *
 * Returns the first non-empty header value, or undefined.
 */
export function readRequestId(headers: Headers, candidates: readonly string[]): string | undefined {
  for (const name of candidates) {
    const value = headers.get(name)
    if (value != null && value !== "") return value
  }
  return undefined
}

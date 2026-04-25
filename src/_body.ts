/**
 * Decide if a method may carry a body. Used to gate body serialization.
 */
export function isPayloadMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
}

/**
 * Serialize a body for `fetch`. JSON-stringifies plain objects/arrays and sets
 * `content-type: application/json` when the user hasn't picked one. Pass-through
 * for FormData/Blob/URLSearchParams/streams/strings.
 */
export function serializeBody(
  body: unknown,
  headers: Record<string, string>,
): BodyInit | null | undefined {
  if (body === undefined) return undefined
  if (body === null) return null

  if (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof ReadableStream
  ) {
    return body as BodyInit
  }

  if (typeof body === "object") {
    if (!hasContentType(headers)) {
      headers["content-type"] = "application/json"
    }
    return JSON.stringify(body)
  }

  return String(body)
}

function hasContentType(headers: Record<string, string>): boolean {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return true
  }
  return false
}

const NULL_BODY_STATUSES = new Set([100, 101, 102, 103, 204, 205, 304])

/**
 * Detect whether a response is body-less (HEAD, 204/304/1xx, content-length: 0).
 * Used to short-circuit JSON.parse and friends. Covers misina #27.
 */
export function isBodylessResponse(response: Response, method: string): boolean {
  if (method === "HEAD") return true
  if (NULL_BODY_STATUSES.has(response.status)) return true
  const length = response.headers.get("content-length")
  if (length === "0") return true
  return false
}

const JSON_RE = /^application\/(?:[\w!#$%&*.^`~-]*\+)?json(;.+)?$/i

export async function parseResponseBody(
  response: Response,
  method: string,
  responseType?: "json" | "text" | "arrayBuffer" | "blob" | "stream",
): Promise<unknown> {
  if (isBodylessResponse(response, method)) {
    if (responseType === "text") return ""
    if (responseType === "arrayBuffer") return new ArrayBuffer(0)
    if (responseType === "blob") return new Blob([])
    if (responseType === "stream") return null
    return undefined
  }

  if (responseType === "stream") return response.body
  if (responseType === "text") return response.text()
  if (responseType === "blob") return response.blob()
  if (responseType === "arrayBuffer") return response.arrayBuffer()

  const ct = response.headers.get("content-type") ?? ""
  if (responseType === "json" || JSON_RE.test(ct)) {
    const text = await response.text()
    if (text === "") return undefined
    return JSON.parse(text)
  }
  if (ct.startsWith("text/")) return response.text()
  return response.arrayBuffer()
}

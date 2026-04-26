import { isJsonContentType } from "./_content_type.ts"

/**
 * Decide if a method may carry a body. Used to gate body serialization.
 *
 * Per RFC 9110: GET / HEAD / OPTIONS / TRACE / CONNECT either don't take
 * a body or it's discouraged enough that we drop it silently. DELETE may
 * carry a body and is allowed.
 */
export function isPayloadMethod(method: string): boolean {
  return (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    method !== "TRACE" &&
    method !== "CONNECT"
  )
}

/**
 * Serialize a body for `fetch`. Plain objects/arrays go through `stringifyJson`
 * (default `JSON.stringify`) and `content-type: application/json` is set when
 * the user hasn't picked one. Pass-through for FormData/Blob/URLSearchParams/
 * streams/strings.
 */
export function serializeBody(
  body: unknown,
  headers: Record<string, string>,
  stringifyJson: (value: unknown) => string,
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

  // Async iterables (including Node's Readable, async generators, and
  // anything implementing Symbol.asyncIterator) → ReadableStream.from(...).
  // Baseline 2024 across Node 22 / Bun / Deno / browsers; lib.dom hasn't
  // typed ReadableStream.from yet, hence the cast.
  if (body !== null && typeof body === "object" && Symbol.asyncIterator in (body as object)) {
    type WithFrom = {
      from(source: AsyncIterable<Uint8Array | string>): ReadableStream<Uint8Array>
    }
    return (ReadableStream as unknown as WithFrom).from(body as AsyncIterable<Uint8Array | string>)
  }

  if (typeof body === "object") {
    // Refuse to silently JSON-stringify class instances that aren't plain
    // objects and don't define toJSON — that path used to swallow {} for
    // a `new MyClass()` payload, which is almost certainly a bug.
    if (!isJsonSerializable(body)) {
      throw new TypeError(
        "misina: body is a non-plain object without a toJSON() method; " +
          "wrap it manually or convert to a plain object before passing.",
      )
    }
    if (!hasContentType(headers)) {
      headers["content-type"] = "application/json"
    }
    return stringifyJson(body)
  }

  return String(body)
}

function isJsonSerializable(value: object): boolean {
  if (Array.isArray(value)) return true
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return true
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasContentType(headers: Record<string, string>): boolean {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return true
  }
  return false
}

const NULL_BODY_STATUSES = new Set([100, 101, 102, 103, 204, 205, 304])

/**
 * Detect whether a response is body-less (HEAD, 204/304/1xx, content-length: 0,
 * opaque cross-origin response). Used to short-circuit JSON.parse and friends.
 * Covers misina #27 and #33.
 */
export function isBodylessResponse(response: Response, method: string): boolean {
  if (method === "HEAD") return true
  if (NULL_BODY_STATUSES.has(response.status)) return true
  if (response.type === "opaque" || response.type === "opaqueredirect") return true
  const length = response.headers.get("content-length")
  if (length === "0") return true
  return false
}

export async function parseResponseBody(
  response: Response,
  method: string,
  parseJson: (text: string, ctx?: { request: Request; response: Response }) => unknown,
  responseType?: "json" | "text" | "arrayBuffer" | "blob" | "stream",
  request?: Request,
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
  if (responseType === "json" || isJsonContentType(ct)) {
    const text = await response.text()
    if (text === "") return undefined
    return parseJson(text, request ? { request, response } : undefined)
  }
  if (ct.startsWith("text/")) return response.text()
  return response.arrayBuffer()
}

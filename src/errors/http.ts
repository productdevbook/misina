import { isProblemJsonContentType } from "../_content_type.ts"
import { readRequestId } from "../_request_id.ts"
import { MisinaError } from "./base.ts"

const DEFAULT_REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-correlation-id"] as const

/**
 * RFC 9457 problem details (formerly RFC 7807). Servers signal application
 * errors with `Content-Type: application/problem+json` and this shape.
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. Default `"about:blank"`. */
  type?: string
  /** Short, human-readable summary. */
  title?: string
  /** HTTP status code (echoed). */
  status?: number
  /** Specific occurrence detail. */
  detail?: string
  /** URI reference identifying the specific occurrence. */
  instance?: string
  /** Custom extension fields are allowed by the spec. */
  [key: string]: unknown
}

/**
 * Thrown when the server responds with a non-2xx status and `throwHttpErrors`
 * is true (the default). Carries the parsed body as `data`, the original
 * `Request` and `Response`, and surfaces RFC 9457 `problem+json` details on
 * `.problem` when applicable.
 *
 * @example
 * ```ts
 * import { HTTPError, isHTTPError } from "misina"
 *
 * try {
 *   const { data } = await api.post<User>("/users", { name: "Alice" })
 * } catch (err) {
 *   if (isHTTPError<{ message: string }>(err)) {
 *     // err.status, err.data.message, err.response.headers all typed
 *     showToast(err.problem?.title ?? err.data.message)
 *   } else throw err
 * }
 * ```
 */
export class HTTPError<T = unknown> extends MisinaError {
  override readonly name = "HTTPError"
  readonly status: number
  readonly statusText: string
  readonly response: Response
  readonly request: Request
  readonly data: T
  /**
   * Parsed RFC 9457 problem details — present when the response had
   * `Content-Type: application/problem+json` and a JSON body. `undefined`
   * otherwise.
   */
  readonly problem: ProblemDetails | undefined
  /**
   * Server-issued request id, read from response headers. Surfaced in the
   * error message as `[req: <id>]` and included in toJSON. Default scan
   * order: `x-request-id`, `request-id`, `x-correlation-id`. Override via
   * `requestIdHeaders` on `createMisina`.
   */
  readonly requestId: string | undefined

  constructor(
    response: Response,
    request: Request,
    data: T,
    requestIdHeaders: readonly string[] = DEFAULT_REQUEST_ID_HEADERS,
  ) {
    const problem = extractProblem(response, data)
    const requestId = readRequestId(response.headers, requestIdHeaders)
    super(buildMessage(response, problem, requestId))
    this.status = response.status
    this.statusText = response.statusText
    this.response = response
    this.request = request
    this.data = data
    this.problem = problem
    this.requestId = requestId
  }

  override toJSON(): Record<string, unknown> {
    const base = super.toJSON()
    return {
      ...base,
      status: this.status,
      statusText: this.statusText,
      request: { method: this.request.method, url: this.request.url },
      response: {
        status: this.response.status,
        statusText: this.response.statusText,
        url: this.response.url,
        headers: Object.fromEntries(this.response.headers),
      },
      data: this.data,
      problem: this.problem,
      requestId: this.requestId,
    }
  }
}

function extractProblem(response: Response, data: unknown): ProblemDetails | undefined {
  const ct = response.headers.get("content-type")
  if (!isProblemJsonContentType(ct)) return undefined
  if (!data || typeof data !== "object") return undefined
  return data as ProblemDetails
}

function buildMessage(
  response: Response,
  problem: ProblemDetails | undefined,
  requestId: string | undefined,
): string {
  const base = `Request failed with status ${response.status} ${response.statusText}`
  // Prefer detail, fall back to title — both are spec-encouraged.
  const blurb = problem ? (problem.detail ?? problem.title) : undefined
  const main = blurb ? `${base}: ${blurb}` : base
  return requestId ? `${main} [req: ${requestId}]` : main
}

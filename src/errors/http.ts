import { isProblemJsonContentType } from "../_content_type.ts"
import { MisinaError } from "./base.ts"

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

  constructor(response: Response, request: Request, data: T) {
    const problem = extractProblem(response, data)
    super(buildMessage(response, problem))
    this.status = response.status
    this.statusText = response.statusText
    this.response = response
    this.request = request
    this.data = data
    this.problem = problem
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
    }
  }
}

function extractProblem(response: Response, data: unknown): ProblemDetails | undefined {
  const ct = response.headers.get("content-type")
  if (!isProblemJsonContentType(ct)) return undefined
  if (!data || typeof data !== "object") return undefined
  return data as ProblemDetails
}

function buildMessage(response: Response, problem: ProblemDetails | undefined): string {
  const base = `Request failed with status ${response.status} ${response.statusText}`
  if (!problem) return base
  // Prefer detail, fall back to title — both are spec-encouraged.
  const blurb = problem.detail ?? problem.title
  return blurb ? `${base}: ${blurb}` : base
}

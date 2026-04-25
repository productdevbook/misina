import { MisinaError } from "./base.ts"

export class HTTPError<T = unknown> extends MisinaError {
  override readonly name = "HTTPError"
  readonly status: number
  readonly statusText: string
  readonly response: Response
  readonly request: Request
  readonly data: T

  constructor(response: Response, request: Request, data: T) {
    super(`Request failed with status ${response.status} ${response.statusText}`)
    this.status = response.status
    this.statusText = response.statusText
    this.response = response
    this.request = request
    this.data = data
  }
}

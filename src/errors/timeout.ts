import { MisinaError } from "./base.ts"

export class TimeoutError extends MisinaError {
  override readonly name = "TimeoutError"
  readonly timeout: number

  constructor(timeout: number, options?: { cause?: unknown }) {
    super(`Request timed out after ${timeout}ms`, options)
    this.timeout = timeout
  }
}

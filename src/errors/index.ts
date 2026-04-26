export { MisinaError } from "./base.ts"
export { HTTPError, type ProblemDetails } from "./http.ts"
export { isRawNetworkError, NetworkError } from "./network.ts"
export { ResponseTooLargeError } from "./response_too_large.ts"
export { TimeoutError } from "./timeout.ts"

import { HTTPError } from "./http.ts"
import { MisinaError } from "./base.ts"
import { NetworkError } from "./network.ts"
import { ResponseTooLargeError } from "./response_too_large.ts"
import { TimeoutError } from "./timeout.ts"

export function isMisinaError(error: unknown): error is MisinaError {
  return error instanceof MisinaError
}

export function isHTTPError<T = unknown>(error: unknown): error is HTTPError<T> {
  return error instanceof HTTPError
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError
}

export function isResponseTooLargeError(error: unknown): error is ResponseTooLargeError {
  return error instanceof ResponseTooLargeError
}

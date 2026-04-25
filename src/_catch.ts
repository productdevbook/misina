import { isHTTPError } from "./errors/index.ts"

export type CatchMatcher = number | number[] | string | ((error: unknown) => boolean)

export interface CatchablePromise<T> extends Promise<T> {
  /**
   * Recover from specific errors. Matcher can be a status code, an array of
   * status codes, an error class name (string), or a predicate.
   *
   * Returning a value resolves the promise; throwing propagates a new error.
   */
  onError: <U = T>(
    matcher: CatchMatcher,
    handler: (error: Error) => U | Promise<U>,
  ) => CatchablePromise<T | U>
}

export function catchable<T>(promise: Promise<T>): CatchablePromise<T> {
  const wrapped = promise as CatchablePromise<T>
  wrapped.onError = function onError<U>(
    matcher: CatchMatcher,
    handler: (error: Error) => U | Promise<U>,
  ): CatchablePromise<T | U> {
    return catchable(
      this.catch(async (error: unknown) => {
        if (matches(matcher, error)) return await handler(error as Error)
        throw error
      }),
    )
  }
  return wrapped
}

function matches(matcher: CatchMatcher, error: unknown): boolean {
  if (typeof matcher === "function") return matcher(error)
  if (typeof matcher === "string") {
    return error instanceof Error && error.name === matcher
  }
  if (typeof matcher === "number") {
    return isHTTPError(error) && error.status === matcher
  }
  if (Array.isArray(matcher)) {
    return isHTTPError(error) && matcher.includes(error.status)
  }
  return false
}

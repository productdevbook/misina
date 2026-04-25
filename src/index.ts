/**
 * Public entry point for `misina` — a driver-based, cross-runtime
 * TypeScript HTTP client. Hooks lifecycle, retry, error taxonomy, and
 * Web Fetch API as the canonical wire format.
 *
 * @module
 */
export { createMisina } from "./misina.ts"

export { defineDriver } from "./driver/_define.ts"

export { replaceOption } from "./_merge.ts"

export {
  HTTPError,
  isHTTPError,
  isMisinaError,
  isNetworkError,
  isTimeoutError,
  MisinaError,
  NetworkError,
  TimeoutError,
} from "./errors/index.ts"

export type {
  AfterResponseHook,
  BeforeErrorHook,
  BeforeRedirectHook,
  BeforeRequestHook,
  BeforeRetryHook,
  CatchMatcher,
  HttpMethod,
  InitHook,
  MaybeArray,
  Misina,
  MisinaContext,
  MisinaDriver,
  MisinaDriverFactory,
  MisinaHooks,
  MisinaOptions,
  MisinaRequestInit,
  MisinaResolvedOptions,
  MisinaResponse,
  MisinaResponsePromise,
  ResolvedHooks,
  ResolvedRetry,
  ResponseType,
  RetryOptions,
} from "./types.ts"

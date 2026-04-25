/**
 * Public entry point for `misina` — a driver-based, cross-runtime
 * TypeScript HTTP client. Hooks lifecycle, retry, error taxonomy, and
 * Web Fetch API as the canonical wire format.
 *
 * @module
 */
export { createMisina } from "./misina.ts"

export { defineDriver } from "./driver/_define.ts"

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
  BeforeRequestHook,
  BeforeRetryHook,
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
  ResponseType,
} from "./types.ts"

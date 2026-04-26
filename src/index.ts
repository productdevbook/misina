/**
 * Public entry point for `misina` — a driver-based, cross-runtime
 * TypeScript HTTP client. Hooks lifecycle, retry, error taxonomy, and
 * Web Fetch API as the canonical wire format.
 *
 * @module
 */
export { createMisina } from "./misina.ts"

export {
  createMisinaTyped,
  isSchemaValidationError,
  SchemaValidationError,
  validated,
  validateSchema,
} from "./typed.ts"

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
  type ProblemDetails,
  TimeoutError,
} from "./errors/index.ts"

export type {
  AfterResponseHook,
  ArrayFormat,
  BeforeErrorHook,
  BeforeRedirectHook,
  BeforeRequestHook,
  BeforeRetryHook,
  CatchMatcher,
  DeferCallback,
  HttpMethod,
  InitHook,
  MaybeArray,
  Misina,
  MisinaContext,
  MisinaDriver,
  MisinaDriverFactory,
  MisinaHooks,
  MisinaMeta,
  MisinaOptions,
  MisinaRequestInit,
  MisinaResolvedOptions,
  MisinaResponse,
  MisinaResponsePromise,
  ParamsSerializer,
  ProgressCallback,
  ProgressEvent,
  ResolvedHooks,
  ResolvedRetry,
  ResponseType,
  RetryOptions,
} from "./types.ts"

export type { EndpointDef, EndpointsMap, StandardSchemaV1, TypedMisina } from "./typed.ts"

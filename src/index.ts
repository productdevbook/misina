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
  path,
  SchemaValidationError,
  validated,
  validateSchema,
} from "./typed.ts"

export type { PathParamsOf } from "./typed.ts"

export { defineDriver } from "./driver/_define.ts"

export { replaceOption } from "./_merge.ts"

export { parseServerTiming } from "./_server_timing.ts"

export { toFile } from "./_to_file.ts"
export type { FileSource, ToFileOptions } from "./_to_file.ts"

export {
  HTTPError,
  isHTTPError,
  isMisinaError,
  isNetworkError,
  isResponseTooLargeError,
  isTimeoutError,
  MisinaError,
  NetworkError,
  type ProblemDetails,
  ResponseTooLargeError,
  TimeoutError,
} from "./errors/index.ts"

export type {
  AfterResponseHook,
  ApplyPlugins,
  ArrayFormat,
  BeforeErrorHook,
  BeforeRedirectHook,
  BeforeRequestHook,
  BeforeRetryHook,
  CatchMatcher,
  CompletionContext,
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
  MisinaPlugin,
  MisinaRequestInit,
  MisinaResolvedOptions,
  MisinaResponse,
  MisinaResponsePromise,
  MisinaResult,
  MisinaState,
  OnCompleteHook,
  ParamsSerializer,
  ProgressCallback,
  ProgressEvent,
  ResolvedHooks,
  ResolvedRetry,
  ResponseType,
  RetryOptions,
  SafeMisina,
  ServerTimingEntry,
} from "./types.ts"

export type {
  EndpointDef,
  EndpointsMap,
  StandardIssue,
  StandardPathItem,
  StandardSchemaV1,
  TypedMisina,
} from "./typed.ts"

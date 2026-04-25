export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

export type ResponseType = "json" | "text" | "arrayBuffer" | "blob" | "stream"

export type MaybeArray<T> = T | T[]

/**
 * Per-phase mutable context shared across hooks for a single request lifecycle.
 * `request` and `response` are populated as the lifecycle progresses.
 */
export interface MisinaContext {
  request: Request
  response?: Response
  options: MisinaResolvedOptions
  attempt: number
  error?: unknown
}

/**
 * Hook fired before the `Request` object is constructed. Receives a mutable,
 * already-cloned options object — mutations are isolated per-request. Sync only.
 * Errors thrown here are fatal (no retry).
 */
export type InitHook = (options: MisinaResolvedOptions) => void

/**
 * Hook fired after the `Request` is built and before it is dispatched to the
 * driver. May return a `Request` (replaces the request) or `Response` (skips
 * fetch entirely). Errors are fatal.
 */
export type BeforeRequestHook = (
  ctx: MisinaContext,
) => void | Request | Response | Promise<void | Request | Response>

/**
 * Hook fired before each retry attempt (attempt >= 1). Receives the error from
 * the previous attempt. May return a `Request` to replace the next request.
 */
export type BeforeRetryHook = (ctx: MisinaContext) => void | Request | Promise<void | Request>

/**
 * Hook fired after a `Response` is received, before status validation.
 * May return a new `Response` (e.g. to bypass an HTTPError throw).
 */
export type AfterResponseHook = (ctx: MisinaContext) => void | Response | Promise<void | Response>

/**
 * Final error transformation. Must return an `Error` (transformed or original).
 */
export type BeforeErrorHook = (error: Error, ctx: MisinaContext) => Error | Promise<Error>

export interface MisinaHooks {
  init?: MaybeArray<InitHook>
  beforeRequest?: MaybeArray<BeforeRequestHook>
  beforeRetry?: MaybeArray<BeforeRetryHook>
  afterResponse?: MaybeArray<AfterResponseHook>
  beforeError?: MaybeArray<BeforeErrorHook>
}

/** Internal: hooks normalized into arrays after defaults+per-request merge. */
export interface ResolvedHooks {
  init: InitHook[]
  beforeRequest: BeforeRequestHook[]
  beforeRetry: BeforeRetryHook[]
  afterResponse: AfterResponseHook[]
  beforeError: BeforeErrorHook[]
}

export interface MisinaOptions {
  baseURL?: string
  headers?: Record<string, string>
  timeout?: number
  signal?: AbortSignal
  responseType?: ResponseType
  hooks?: MisinaHooks
  driver?: MisinaDriver
  /** Override fetch implementation when using the default fetch driver. */
  fetch?: typeof globalThis.fetch
  /** Throw `HTTPError` for non-2xx responses. Default: true. */
  throwHttpErrors?: boolean
}

/**
 * Per-request init — superset of `MisinaOptions` plus URL/method/body knobs.
 */
export interface MisinaRequestInit extends MisinaOptions {
  method?: HttpMethod
  body?: unknown
  query?: Record<string, unknown>
}

/**
 * Resolved, normalized options after defaults merge. Hooks receive this.
 */
export interface MisinaResolvedOptions {
  url: string
  method: HttpMethod
  headers: Record<string, string>
  body?: unknown
  query?: Record<string, unknown>
  baseURL?: string
  timeout?: number
  signal?: AbortSignal
  responseType?: ResponseType
  hooks: ResolvedHooks
  throwHttpErrors: boolean
}

export interface MisinaResponse<T = unknown> {
  data: T
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  raw: Response
}

export interface Misina {
  request: <T = unknown>(input: string, init?: MisinaRequestInit) => Promise<MisinaResponse<T>>
  get: <T = unknown>(url: string, init?: MisinaRequestInit) => Promise<MisinaResponse<T>>
  post: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResponse<T>>
  put: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResponse<T>>
  patch: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResponse<T>>
  delete: <T = unknown>(url: string, init?: MisinaRequestInit) => Promise<MisinaResponse<T>>
  head: <T = unknown>(url: string, init?: MisinaRequestInit) => Promise<MisinaResponse<T>>
  options: <T = unknown>(url: string, init?: MisinaRequestInit) => Promise<MisinaResponse<T>>
}

/**
 * Driver interface — pluggable transport. Drivers receive a real `Request` and
 * return a real `Response`, keeping the `Web Fetch API` shape canonical.
 */
export interface MisinaDriver {
  readonly name: string
  request: (request: Request) => Promise<Response>
}

export type MisinaDriverFactory<TOptions = void> = TOptions extends void
  ? () => MisinaDriver
  : (options: TOptions) => MisinaDriver

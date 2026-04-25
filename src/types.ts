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
 * Hook fired before each cross-origin or same-origin redirect when redirect
 * mode is `'manual'` (default for misina). Receives the prepared next
 * request after sensitive headers have been stripped per policy.
 */
export type BeforeRedirectHook = (info: {
  request: Request
  response: Response
  options: MisinaResolvedOptions
  attempt: number
  sameOrigin: boolean
}) => void | Request | Promise<void | Request>

/**
 * Final error transformation. Must return an `Error` (transformed or original).
 */
export type BeforeErrorHook = (error: Error, ctx: MisinaContext) => Error | Promise<Error>

export interface RetryOptions {
  /** Max retry attempts. Default: 2. */
  limit?: number
  /** Retriable methods. Default: GET/PUT/HEAD/DELETE/OPTIONS. */
  methods?: HttpMethod[]
  /** HTTP status codes that trigger retry. Default: [408,413,429,500,502,503,504]. */
  statusCodes?: number[]
  /** Status codes that honor Retry-After/RateLimit-Reset headers. Default: [413,429,503]. */
  afterStatusCodes?: number[]
  /** Cap on Retry-After header value (ms). */
  maxRetryAfter?: number
  /** Compute delay before attempt N (1-indexed). Default: 0.3 * 2^(n-1) * 1000. */
  delay?: (attempt: number) => number
  /** Cap on computed delay (ms). Default: Infinity. */
  backoffLimit?: number
  /** Apply random jitter to delay. true → full jitter (Math.random() * delay). */
  jitter?: boolean | ((delay: number) => number)
  /** Final escape hatch — return false to abort, true to force retry. */
  shouldRetry?: (ctx: MisinaContext) => boolean | Promise<boolean>
  /** Whether to retry on TimeoutError. Default: true. */
  retryOnTimeout?: boolean
}

export interface ResolvedRetry {
  limit: number
  methods: HttpMethod[]
  statusCodes: number[]
  afterStatusCodes: number[]
  maxRetryAfter: number | undefined
  delay: (attempt: number) => number
  backoffLimit: number
  jitter: boolean | ((delay: number) => number)
  shouldRetry: ((ctx: MisinaContext) => boolean | Promise<boolean>) | undefined
  retryOnTimeout: boolean
}

export interface MisinaHooks {
  init?: MaybeArray<InitHook>
  beforeRequest?: MaybeArray<BeforeRequestHook>
  beforeRetry?: MaybeArray<BeforeRetryHook>
  beforeRedirect?: MaybeArray<BeforeRedirectHook>
  afterResponse?: MaybeArray<AfterResponseHook>
  beforeError?: MaybeArray<BeforeErrorHook>
}

/** Internal: hooks normalized into arrays after defaults+per-request merge. */
export interface ResolvedHooks {
  init: InitHook[]
  beforeRequest: BeforeRequestHook[]
  beforeRetry: BeforeRetryHook[]
  beforeRedirect: BeforeRedirectHook[]
  afterResponse: AfterResponseHook[]
  beforeError: BeforeErrorHook[]
}

export interface MisinaOptions {
  baseURL?: string
  /** Allow absolute URLs in the request input to override baseURL. Default: true. */
  allowAbsoluteUrls?: boolean
  headers?: Record<string, string>
  /** Per-attempt timeout in milliseconds. Default: 10_000. `false` to disable. */
  timeout?: number | false
  /** Wall-clock deadline across all attempts (incl. retry delays). Default: false (disabled). */
  totalTimeout?: number | false
  signal?: AbortSignal
  responseType?: ResponseType
  hooks?: MisinaHooks
  /** Retry policy — number for limit, false to disable, or full RetryOptions object. */
  retry?: number | boolean | RetryOptions
  driver?: MisinaDriver
  /** Override fetch implementation when using the default fetch driver. */
  fetch?: typeof globalThis.fetch
  /** Throw `HTTPError` for non-2xx responses. Default: true. Set false for sugar over validateResponse. */
  throwHttpErrors?: boolean
  /**
   * Predicate that decides whether a response counts as success. Receives the
   * status, headers, parsed body, and raw Response. Return `true` to resolve,
   * `false` to throw `HTTPError`, or an `Error` instance to throw that error.
   * Default: `status >= 200 && status < 300`.
   */
  validateResponse?: (info: {
    status: number
    headers: Headers
    data: unknown
    response: Response
  }) => boolean | Error
  /**
   * Redirect handling.
   * - `'manual'` (default): misina follows redirects, applies header policy, fires beforeRedirect.
   * - `'follow'`: hand off to the underlying transport (fast path, no policy).
   * - `'error'`: throw on any 3xx.
   */
  redirect?: "manual" | "follow" | "error"
  /** Allowlist of headers preserved on cross-origin redirects. Default: accept, accept-encoding, accept-language, user-agent. */
  redirectSafeHeaders?: string[]
  /** Max redirects to follow before throwing. Default: 5. */
  redirectMaxCount?: number
  /** Allow https → http redirect. Default: false. */
  redirectAllowDowngrade?: boolean
  /** Custom JSON parser. Default: JSON.parse. */
  parseJson?: (text: string) => unknown
  /** Custom JSON serializer for request bodies. Default: JSON.stringify. */
  stringifyJson?: (value: unknown) => string
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
  allowAbsoluteUrls: boolean
  method: HttpMethod
  headers: Record<string, string>
  body?: unknown
  query?: Record<string, unknown>
  baseURL?: string
  timeout: number | false
  totalTimeout: number | false
  signal?: AbortSignal
  responseType?: ResponseType
  hooks: ResolvedHooks
  retry: ResolvedRetry
  redirect: "manual" | "follow" | "error"
  redirectSafeHeaders: string[] | undefined
  redirectMaxCount: number
  redirectAllowDowngrade: boolean
  throwHttpErrors: boolean
  validateResponse:
    | ((info: {
        status: number
        headers: Headers
        data: unknown
        response: Response
      }) => boolean | Error)
    | undefined
  parseJson: (text: string) => unknown
  stringifyJson: (value: unknown) => string
}

export interface MisinaResponse<T = unknown> {
  data: T
  status: number
  statusText: string
  headers: Record<string, string>
  url: string
  /** Web Fetch ResponseType — basic / cors / opaque / opaqueredirect / error / default. */
  type: Response["type"]
  raw: Response
}

export type CatchMatcher = number | number[] | string | ((error: unknown) => boolean)

export interface MisinaResponsePromise<T> extends Promise<MisinaResponse<T>> {
  /**
   * Recover from specific errors. Matcher can be a status code, an array of
   * status codes, an error class name (string), or a predicate.
   */
  onError: <U = MisinaResponse<T>>(
    matcher: CatchMatcher,
    handler: (error: Error) => U | Promise<U>,
  ) => MisinaResponsePromise<T> & Promise<MisinaResponse<T> | U>
}

export interface Misina {
  /**
   * Create a new Misina instance with deep-merged defaults. Hooks arrays
   * concat, headers shallow-merge, primitives → child wins. Wrap a value
   * with `replaceOption()` to force replace at any depth.
   *
   * Function form receives the parent defaults so child can read them.
   */
  extend: (defaults: MisinaOptions | ((parent: MisinaOptions) => MisinaOptions)) => Misina
  request: <T = unknown>(input: string, init?: MisinaRequestInit) => MisinaResponsePromise<T>
  get: <T = unknown>(url: string, init?: MisinaRequestInit) => MisinaResponsePromise<T>
  post: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T>
  put: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T>
  patch: <T = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T>
  delete: <T = unknown>(url: string, init?: MisinaRequestInit) => MisinaResponsePromise<T>
  head: <T = unknown>(url: string, init?: MisinaRequestInit) => MisinaResponsePromise<T>
  options: <T = unknown>(url: string, init?: MisinaRequestInit) => MisinaResponsePromise<T>
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

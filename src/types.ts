import type { HTTPError } from "./errors/http.ts"

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "QUERY"

export type ResponseType = "json" | "text" | "arrayBuffer" | "blob" | "stream"

export type MaybeArray<T> = T | T[]

/**
 * Per-request user data carried on `init.meta` and reachable via
 * `ctx.options.meta` in every hook. Empty by default — augment via module
 * augmentation in your project to add typed keys (TanStack Query pattern).
 */
// biome-ignore lint/complexity/noBannedTypes: empty interface is the augmentation surface
export interface MisinaMeta {}

/**
 * Per-phase mutable context shared across hooks for a single request lifecycle.
 * `request` and `response` are populated as the lifecycle progresses.
 */
export interface MisinaContext {
  request: Request
  response?: Response
  options: MisinaResolvedOptions
  attempt: number
  /** performance.now() at the start of this lifecycle. */
  startedAt: number
  /** performance.now() when the first response was received. */
  responseStartedAt?: number
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
 * the previous attempt.
 *
 * - Return a `Request` to replace the request used for the next attempt.
 * - Return a `Response` to short-circuit retries entirely with that response
 *   (cache fallback, manually-built default, etc.) — no further network
 *   request is made and the hook chain stops.
 */
export type BeforeRetryHook = (
  ctx: MisinaContext,
) => void | Request | Response | Promise<void | Request | Response>

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

/**
 * Terminal-state hook — fires exactly once per logical call after retries
 * and redirects, with either `response` or `error` populated. Useful for
 * logging, metrics, distributed tracing.
 */
export type OnCompleteHook = (info: CompletionContext) => void | Promise<void>

export interface CompletionContext {
  request: Request
  response: Response | undefined
  error: Error | undefined
  durationMs: number
  attempt: number
  options: MisinaResolvedOptions
}

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
  onComplete?: MaybeArray<OnCompleteHook>
}

/** Internal: hooks normalized into arrays after defaults+per-request merge. */
export interface ResolvedHooks {
  init: InitHook[]
  beforeRequest: BeforeRequestHook[]
  beforeRetry: BeforeRetryHook[]
  beforeRedirect: BeforeRedirectHook[]
  afterResponse: AfterResponseHook[]
  beforeError: BeforeErrorHook[]
  onComplete: OnCompleteHook[]
}

export interface MisinaOptions {
  baseURL?: string
  /** Allow absolute URLs in the request input to override baseURL. Default: true. */
  allowAbsoluteUrls?: boolean
  /**
   * Allowlist of URL protocols misina will dispatch. Default: `["http","https"]`.
   * Add embedded runtime schemes (`"capacitor"`, `"tauri"`, custom protocols)
   * here to use them; relative URLs and unparseable inputs skip the check.
   */
  allowedProtocols?: readonly string[]
  /**
   * Trailing-slash policy for the final URL:
   * - `"preserve"` (default) — leave the URL alone.
   * - `"strip"` — remove trailing slashes from the path before dispatch.
   * - `"forbid"` — throw if the path ends with `/`.
   *
   * Useful as a guardrail when a backend 404s on the wrong canonical form.
   */
  trailingSlash?: "preserve" | "strip" | "forbid"
  /**
   * Per-request user data — flows through every hook on `ctx.options.meta`.
   *
   * Use module augmentation to type your project's keys:
   *
   * ```ts
   * declare module "misina" {
   *   interface MisinaMeta {
   *     tag?: string
   *     tenant?: string
   *   }
   * }
   * ```
   */
  meta?: MisinaMeta
  /**
   * HTTP headers. Accepts a Record, a Headers instance, or [k, v] tuple pairs.
   * Values that are `undefined` or `null` are silently dropped — handy for
   * optional headers like `{ authorization: token ?? undefined }`.
   */
  headers?: HeadersInit | Record<string, string | undefined>
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
  }) => boolean | Error | Promise<boolean | Error>
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
  /**
   * Custom JSON parser. Default: JSON.parse. Optional context (request +
   * response) lets advanced parsers route on URL or content-type
   * (matches ky [PR #849](https://github.com/sindresorhus/ky/pull/849)).
   */
  parseJson?: (text: string, ctx?: { request: Request; response: Response }) => unknown
  /** Custom JSON serializer for request bodies. Default: JSON.stringify. */
  stringifyJson?: (value: unknown) => string
  /** How arrays in `query` are serialized. Default: 'repeat'. */
  arrayFormat?: ArrayFormat
  /** Override query string serialization wholesale. */
  paramsSerializer?: ParamsSerializer
  /**
   * Late-binding callbacks evaluated *after* init hooks but *before*
   * beforeRequest. Each returns a partial options object that is shallow-merged
   * (headers/query merged) into the resolved options. Use for per-request
   * tokens, timestamps, or anything you don't have at instance creation time.
   */
  defer?: MaybeArray<DeferCallback>
  /** Fired as the request body is sent to the network in 64 KB chunks. */
  onUploadProgress?: ProgressCallback
  /** Fired as the response body is consumed. */
  onDownloadProgress?: ProgressCallback
  /**
   * Send an `Idempotency-Key` header on retried mutations so the server can
   * deduplicate. The same key is reused across all attempts of one logical
   * request — the whole point.
   *
   * - `'auto'` — generate a `crypto.randomUUID()` for non-idempotent methods
   *   (POST, PATCH, DELETE) when `retry > 0` and the user hasn't set one.
   * - `string` — use this exact value (must be stable per call).
   * - `(req) => string` — custom generator, called once per logical request.
   * - `false` (default) — disabled; misina sends nothing.
   *
   * Per draft-ietf-httpapi-idempotency-key. No competitor ships this today.
   */
  idempotencyKey?: false | "auto" | string | ((request: Request) => string)
  /**
   * `RequestInit.priority` — fetch priority hint. Pass-through to the
   * underlying transport. Modern browsers and Workers honor this.
   */
  priority?: "high" | "low" | "auto"
  /** Standard `fetch` cache mode, passed through to runtime / Next.js. */
  cache?: RequestCache
  /** Standard `fetch` credentials mode. Only sent when explicitly set. */
  credentials?: RequestCredentials
  /**
   * Next.js `fetch` extension. Pass-through to the runtime; no behavior in
   * misina itself. Use module augmentation to refine the type for Next.
   */
  next?: { revalidate?: number | false; tags?: string[] } & Record<string, unknown>
}

export interface ProgressEvent {
  loaded: number
  total: number | undefined
  percent: number
  bytesPerSecond: number
}

export type ProgressCallback = (event: ProgressEvent) => void

export type DeferCallback = (
  options: MisinaResolvedOptions,
) => Partial<MisinaOptions> | undefined | Promise<Partial<MisinaOptions> | undefined>

export type ArrayFormat = "repeat" | "brackets" | "comma" | "indices"

export type ParamsSerializer = (params: Record<string, unknown>) => string

/**
 * Per-request init — superset of `MisinaOptions` plus URL/method/body knobs.
 */
export interface MisinaRequestInit extends MisinaOptions {
  method?: HttpMethod
  body?: unknown
  query?: Record<string, unknown> | URLSearchParams | string
}

/**
 * Resolved, normalized options after defaults merge. Hooks receive this.
 */
export interface MisinaResolvedOptions {
  url: string
  allowAbsoluteUrls: boolean
  allowedProtocols: readonly string[]
  trailingSlash: "preserve" | "strip" | "forbid"
  meta: MisinaMeta
  method: HttpMethod
  headers: Record<string, string>
  body?: unknown
  query?: Record<string, unknown> | URLSearchParams | string
  arrayFormat: ArrayFormat
  paramsSerializer: ParamsSerializer | undefined
  baseURL?: string
  timeout: number | false
  totalTimeout: number | false
  signal?: AbortSignal
  responseType?: ResponseType
  hooks: ResolvedHooks
  retry: ResolvedRetry
  defer: DeferCallback[]
  onUploadProgress: ProgressCallback | undefined
  onDownloadProgress: ProgressCallback | undefined
  cache: RequestCache | undefined
  credentials: RequestCredentials | undefined
  priority: "high" | "low" | "auto" | undefined
  idempotencyKey: false | "auto" | string | ((request: Request) => string)
  next: { revalidate?: number | false; tags?: string[] } | undefined
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
      }) => boolean | Error | Promise<boolean | Error>)
    | undefined
  parseJson: (text: string, ctx?: { request: Request; response: Response }) => unknown
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
  /** Wall-clock timings for the request lifecycle. */
  timings: ResponseTimings
  raw: Response
}

export interface ResponseTimings {
  /** performance.now() at the start of the request. */
  start: number
  /** performance.now() when the response object was first received. */
  responseStart: number
  /** performance.now() when the response body was fully consumed. */
  end: number
  /** End - start (ms). */
  total: number
}

export type CatchMatcher = number | number[] | string | ((error: unknown) => boolean)

/**
 * Discriminated result type returned by `misina.safe.*` methods. Uses Go-style
 * branching so both success and failure paths get full type safety.
 */
export type MisinaResult<T, E = unknown> =
  | { ok: true; data: T; response: MisinaResponse<T>; error?: undefined }
  | {
      ok: false
      data?: undefined
      response: MisinaResponse<unknown> | undefined
      error: HTTPError<E> | Error
    }

/**
 * Same surface as `Misina` but every method returns a `MisinaResult` instead
 * of throwing. Perfect for hot UI code where TypeScript needs to discriminate
 * branches without `try/catch` widening to `unknown`.
 */
export interface SafeMisina {
  request: <T = unknown, E = unknown>(
    input: string,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  get: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  post: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  put: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  patch: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  delete: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  head: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  options: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
  query: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => Promise<MisinaResult<T, E>>
}

export interface MisinaResponsePromise<T, E = unknown> extends Promise<MisinaResponse<T>> {
  /**
   * Recover from specific errors. Matcher can be a status code, an array of
   * status codes, an error class name (string), or a predicate.
   */
  onError: <U = MisinaResponse<T>>(
    matcher: CatchMatcher,
    handler: (error: HTTPError<E> | Error) => U | Promise<U>,
  ) => MisinaResponsePromise<T, E> & Promise<MisinaResponse<T> | U>
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
  request: <T = unknown, E = unknown>(
    input: string,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  get: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  post: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  put: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  patch: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  delete: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  head: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  options: <T = unknown, E = unknown>(
    url: string,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  /**
   * HTTP `QUERY` method (IETF draft-ietf-httpbis-safe-method-w-body) — a safe,
   * idempotent verb that carries a request body. Useful for complex search
   * filters that don't fit cleanly in a query string.
   */
  query: <T = unknown, E = unknown>(
    url: string,
    body?: unknown,
    init?: MisinaRequestInit,
  ) => MisinaResponsePromise<T, E>
  /**
   * No-throw companion. `misina.safe.get<T, E>(url)` returns
   * `Promise<MisinaResult<T, E>>` — a discriminated `{ ok, data, error,
   * response }` object so both branches are type-safe at the call site.
   */
  safe: SafeMisina
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

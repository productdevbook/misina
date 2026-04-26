import { isPayloadMethod, parseResponseBody, serializeBody } from "./_body.ts"
import { catchable } from "./_catch.ts"
import { mergeHooks } from "./_hooks.ts"
import { mergeOptions } from "./_merge.ts"
import { progressDownload, progressUpload, supportsRequestStreams } from "./_progress.ts"
import { followRedirects } from "./_redirect.ts"
import {
  calculateRetryDelay,
  delayMs,
  resolveRetry,
  shouldRetryHttpError,
  shouldRetryNetworkError,
} from "./_retry.ts"
import { composeSignals, isOurTimeoutAbort, timeoutSignal } from "./_signal.ts"
import { appendQuery, resolveUrl } from "./_url.ts"
import fetchDriverFactory from "./driver/fetch.ts"
import { HTTPError, isRawNetworkError, NetworkError, TimeoutError } from "./errors/index.ts"
import type {
  HttpMethod,
  Misina,
  MisinaContext,
  MisinaDriver,
  MisinaOptions,
  MisinaRequestInit,
  MisinaResolvedOptions,
  MisinaResponse,
  MisinaResponsePromise,
  MisinaResult,
  SafeMisina,
} from "./types.ts"

// Methods that never accept a request body. DELETE is intentionally absent —
// per RFC 9110 a DELETE may carry a body, and several APIs (e.g. Elastic,
// Stripe webhook deletion) require it.
const METHODS_WITHOUT_BODY: HttpMethod[] = ["GET", "HEAD", "OPTIONS"]

const DEFAULT_TIMEOUT = 10_000

export function createMisina(defaults: MisinaOptions = {}): Misina {
  const driver: MisinaDriver =
    defaults.driver ?? fetchDriverFactory({ fetch: defaults.fetch } as never)

  async function request<T = unknown>(
    input: string,
    init: MisinaRequestInit = {},
  ): Promise<MisinaResponse<T>> {
    const options = resolveOptions(input, init, defaults)
    const startedAt = performance.now()

    for (const initHook of options.hooks.init) initHook(options)

    // Honor an already-aborted user signal before any driver/hook runs.
    if (options.signal?.aborted) throw abortReasonAsError(options.signal)

    await applyDefer(options, defaults, init)

    const totalDeadline = computeDeadline(options.totalTimeout)
    const totalSignal = totalDeadline ? deadlineSignal(totalDeadline) : undefined

    let request = await buildRequest(options, totalSignal)
    const ctx: MisinaContext = { request, options, attempt: 0, startedAt }

    for (const hook of options.hooks.beforeRequest) {
      const out = await hook(ctx)
      if (out instanceof Response) {
        return finalizeResponse<T>(out, ctx)
      }
      if (out instanceof Request) {
        ctx.request = out
        request = out
      }
    }

    return runWithRetry<T>(ctx, totalSignal)
  }

  async function runWithRetry<T>(
    ctx: MisinaContext,
    totalSignal: AbortSignal | undefined,
  ): Promise<MisinaResponse<T>> {
    const { options } = ctx
    const { retry } = options

    let lastError: Error | undefined
    let lastResponse: Response | undefined

    // Snapshot the original request and never hand it to the driver directly.
    // Each attempt clones it so the body can be re-read on retry. Streamed
    // bodies cannot be cloned after the first read — those still require
    // an explicit beforeRetry override (pinned in test/stream-retry.test.ts).
    const originalRequest = applyIdempotencyKey(ctx.request, options)
    ctx.request = originalRequest
    let userOverride: Request | undefined

    for (let attempt = 0; attempt <= retry.limit; attempt++) {
      ctx.attempt = attempt

      if (attempt > 0) {
        const delay = calculateRetryDelay(retry, attempt, lastResponse)
        await delayMs(delay, totalSignal ?? options.signal)

        // delayMs returns when the signal aborts; surface that as the rejection
        // instead of letting another driver attempt go out.
        if (options.signal?.aborted) throw abortReasonAsError(options.signal)
        if (totalSignal?.aborted) throw abortReasonAsError(totalSignal)

        for (const hook of options.hooks.beforeRetry) {
          const out = await hook(ctx)
          if (out instanceof Request) {
            userOverride = out
            ctx.request = out
          } else if (out instanceof Response) {
            // Hook supplied a synthetic response (cache fallback, etc.) —
            // skip the network and finalize as if it came from the driver.
            ctx.response = out
            return finalizeResponse<T>(out, ctx)
          }
        }
      }

      const attemptSignal = buildAttemptSignal(options, totalSignal)
      const baseRequest = userOverride ?? originalRequest.clone()
      const attemptRequest = withSignal(baseRequest, attemptSignal)

      let response: Response
      try {
        response = await followRedirects(driver, attemptRequest, options, ctx)
        ctx.responseStartedAt = performance.now()
      } catch (cause) {
        const error = mapTransportError(
          cause,
          attemptSignal,
          attemptRequest.url,
          options.timeout === false ? undefined : options.timeout,
        )
        lastError = error

        if (await canRetryError(retry, ctx, error, attempt)) continue
        throw await runBeforeError(error, ctx)
      }

      if (options.onDownloadProgress) {
        response = progressDownload(response, options.onDownloadProgress)
      }

      ctx.response = response
      lastResponse = response

      for (const hook of options.hooks.afterResponse) {
        const out = await hook(ctx)
        if (out instanceof Response) {
          ctx.response = out
          response = out
          lastResponse = out
        }
      }

      if (attempt < retry.limit && !response.ok && shouldRetryHttpError(retry, options, response)) {
        // Parse the body so shouldRetry / beforeRetry hooks can inspect ctx.error.data
        const cloned = response.clone()
        const data = await parseResponseBody(
          cloned,
          options.method,
          options.parseJson,
          options.responseType,
          ctx.request,
        )
        const httpError = new HTTPError(response, ctx.request, data)
        ctx.error = httpError
        if (await passesShouldRetry(retry, ctx)) {
          lastError = httpError
          continue
        }
      }

      return finalizeResponse<T>(response, ctx)
    }

    throw await runBeforeError(lastError ?? new Error("Retry exhausted"), ctx)
  }

  async function canRetryError(
    retry: ReturnType<typeof resolveRetry>,
    ctx: MisinaContext,
    error: Error,
    attempt: number,
  ): Promise<boolean> {
    if (attempt >= retry.limit) return false
    ctx.error = error

    if (error instanceof TimeoutError) {
      if (!retry.retryOnTimeout) return false
      return passesShouldRetry(retry, ctx)
    }
    if (error instanceof NetworkError) {
      if (!shouldRetryNetworkError(retry, ctx.options)) return false
      return passesShouldRetry(retry, ctx)
    }
    return false
  }

  async function passesShouldRetry(
    retry: ReturnType<typeof resolveRetry>,
    ctx: MisinaContext,
  ): Promise<boolean> {
    if (!retry.shouldRetry) return true
    return await retry.shouldRetry(ctx)
  }

  async function finalizeResponse<T>(
    response: Response,
    ctx: MisinaContext,
  ): Promise<MisinaResponse<T>> {
    const { options } = ctx
    // Error responses get a parse-tolerant path: a malformed JSON 500 should
    // still surface as HTTPError(status=500, data=<text>), not a SyntaxError
    // that buries the real failure.
    const data =
      !response.ok && options.throwHttpErrors
        ? await parseResponseBodyTolerant(response, options, ctx)
        : await parseResponseBody(
            response,
            options.method,
            options.parseJson,
            options.responseType,
            ctx.request,
          )

    if (options.validateResponse) {
      const verdict = await options.validateResponse({
        status: response.status,
        headers: response.headers,
        data,
        response,
      })
      if (verdict instanceof Error) {
        throw await runBeforeError(verdict, ctx)
      }
      if (verdict === false) {
        const error = new HTTPError(response, ctx.request, data)
        throw await runBeforeError(error, ctx)
      }
    } else if (options.throwHttpErrors && !response.ok) {
      const error = new HTTPError(response, ctx.request, data)
      throw await runBeforeError(error, ctx)
    }

    const end = performance.now()
    await runOnComplete(ctx, response, undefined, end)
    return {
      data: data as T,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      url: response.url || ctx.request.url,
      type: response.type,
      timings: {
        start: ctx.startedAt,
        responseStart: ctx.responseStartedAt ?? end,
        end,
        total: end - ctx.startedAt,
      },
      raw: response,
    }
  }

  async function runBeforeError(error: Error, ctx: MisinaContext): Promise<Error> {
    let current = error
    for (const hook of ctx.options.hooks.beforeError) {
      current = await hook(current, ctx)
    }
    await runOnComplete(ctx, ctx.response, current, performance.now())
    return current
  }

  async function runOnComplete(
    ctx: MisinaContext,
    response: Response | undefined,
    error: Error | undefined,
    endedAt: number,
  ): Promise<void> {
    const hooks = ctx.options.hooks.onComplete
    if (hooks.length === 0) return
    const info = {
      request: ctx.request,
      response,
      error,
      durationMs: endedAt - ctx.startedAt,
      attempt: ctx.attempt,
      options: ctx.options,
    }
    for (const hook of hooks) {
      await hook(info)
    }
  }

  function callable<T>(input: string, init: MisinaRequestInit): MisinaResponsePromise<T> {
    return catchable(request<T>(input, init)) as MisinaResponsePromise<T>
  }

  function bind(method: HttpMethod) {
    return <T = unknown>(url: string, init?: MisinaRequestInit): MisinaResponsePromise<T> =>
      callable<T>(url, { ...init, method })
  }

  function bindWithBody(method: HttpMethod) {
    return <T = unknown>(
      url: string,
      body?: unknown,
      init?: MisinaRequestInit,
    ): MisinaResponsePromise<T> => callable<T>(url, { ...init, method, body })
  }

  async function safeCall<T, E>(
    method: HttpMethod,
    input: string,
    body: unknown,
    init?: MisinaRequestInit,
  ): Promise<MisinaResult<T, E>> {
    try {
      const response = await callable<T>(input, { ...init, method, body })
      return { ok: true, data: response.data, response }
    } catch (e) {
      const error = e as Error
      const response = (error as { response?: Response }).response as Response | undefined
      // For HTTPError we already have the parsed body — surface a
      // synthesized MisinaResponse<unknown> so callers can read headers.
      let outResponse: MisinaResponse<unknown> | undefined
      if (response instanceof Response) {
        outResponse = {
          data: (error as { data?: unknown }).data,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
          url: response.url,
          type: response.type,
          timings: { start: 0, responseStart: 0, end: 0, total: 0 },
          raw: response,
        }
      }
      return { ok: false, response: outResponse, error: error as HTTPError<E> | Error }
    }
  }

  const safe: SafeMisina = {
    request: <T = unknown, E = unknown>(input: string, init?: MisinaRequestInit) =>
      safeCall<T, E>((init?.method ?? "GET") as HttpMethod, input, init?.body, init),
    get: <T = unknown, E = unknown>(url: string, init?: MisinaRequestInit) =>
      safeCall<T, E>("GET", url, undefined, init),
    post: <T = unknown, E = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      safeCall<T, E>("POST", url, body, init),
    put: <T = unknown, E = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      safeCall<T, E>("PUT", url, body, init),
    patch: <T = unknown, E = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      safeCall<T, E>("PATCH", url, body, init),
    delete: <T = unknown, E = unknown>(url: string, init?: MisinaRequestInit) =>
      safeCall<T, E>("DELETE", url, undefined, init),
    head: <T = unknown, E = unknown>(url: string, init?: MisinaRequestInit) =>
      safeCall<T, E>("HEAD", url, undefined, init),
    options: <T = unknown, E = unknown>(url: string, init?: MisinaRequestInit) =>
      safeCall<T, E>("OPTIONS", url, undefined, init),
    query: <T = unknown, E = unknown>(url: string, body?: unknown, init?: MisinaRequestInit) =>
      safeCall<T, E>("QUERY", url, body, init),
  }

  const misina: Misina = {
    extend: (input) => {
      const child = typeof input === "function" ? input(defaults) : input
      return createMisina(mergeOptions(defaults, child))
    },
    request: <T = unknown>(input: string, init?: MisinaRequestInit) =>
      callable<T>(input, init ?? {}),
    get: bind("GET"),
    post: bindWithBody("POST"),
    put: bindWithBody("PUT"),
    patch: bindWithBody("PATCH"),
    delete: bind("DELETE"),
    head: bind("HEAD"),
    options: bind("OPTIONS"),
    query: bindWithBody("QUERY"),
    safe,
  }

  return misina
}

function resolveOptions(
  input: string,
  init: MisinaRequestInit,
  defaults: MisinaOptions,
): MisinaResolvedOptions {
  const method = (init.method ?? "GET") as HttpMethod
  const baseURL = init.baseURL ?? defaults.baseURL
  const allowAbsoluteUrls = init.allowAbsoluteUrls ?? defaults.allowAbsoluteUrls ?? true
  const allowedProtocols = init.allowedProtocols ?? defaults.allowedProtocols ?? ["http", "https"]
  const trailingSlash = init.trailingSlash ?? defaults.trailingSlash ?? "preserve"
  const headers = mergeHeaders(defaults.headers, init.headers)
  const arrayFormat = init.arrayFormat ?? defaults.arrayFormat ?? "repeat"
  const paramsSerializer = init.paramsSerializer ?? defaults.paramsSerializer
  const url = appendQuery(
    resolveUrl(input, baseURL, allowAbsoluteUrls, allowedProtocols, trailingSlash),
    init.query,
    arrayFormat,
    paramsSerializer,
  )

  const body = METHODS_WITHOUT_BODY.includes(method) ? undefined : init.body

  return {
    url,
    allowAbsoluteUrls,
    allowedProtocols,
    trailingSlash,
    meta: { ...defaults.meta, ...init.meta },
    method,
    headers,
    body,
    query: init.query,
    arrayFormat,
    paramsSerializer,
    baseURL,
    timeout: init.timeout ?? defaults.timeout ?? DEFAULT_TIMEOUT,
    totalTimeout: init.totalTimeout ?? defaults.totalTimeout ?? false,
    signal: init.signal ?? defaults.signal,
    responseType: init.responseType ?? defaults.responseType,
    hooks: mergeHooks(defaults.hooks, init.hooks),
    retry: resolveRetry(init.retry, resolveRetry(defaults.retry)),
    defer: [
      ...(Array.isArray(defaults.defer) ? defaults.defer : defaults.defer ? [defaults.defer] : []),
      ...(Array.isArray(init.defer) ? init.defer : init.defer ? [init.defer] : []),
    ],
    onUploadProgress: init.onUploadProgress ?? defaults.onUploadProgress,
    onDownloadProgress: init.onDownloadProgress ?? defaults.onDownloadProgress,
    cache: init.cache ?? defaults.cache,
    credentials: init.credentials ?? defaults.credentials,
    priority: init.priority ?? defaults.priority,
    idempotencyKey: init.idempotencyKey ?? defaults.idempotencyKey ?? false,
    next: init.next ?? defaults.next,
    redirect: init.redirect ?? defaults.redirect ?? "manual",
    redirectSafeHeaders: init.redirectSafeHeaders ?? defaults.redirectSafeHeaders,
    redirectMaxCount: init.redirectMaxCount ?? defaults.redirectMaxCount ?? 5,
    redirectAllowDowngrade: init.redirectAllowDowngrade ?? defaults.redirectAllowDowngrade ?? false,
    throwHttpErrors: init.throwHttpErrors ?? defaults.throwHttpErrors ?? true,
    validateResponse: init.validateResponse ?? defaults.validateResponse,
    parseJson: init.parseJson ?? defaults.parseJson ?? defaultParseJson,
    stringifyJson: init.stringifyJson ?? defaults.stringifyJson ?? JSON.stringify,
  }
}

function defaultParseJson(text: string): unknown {
  return JSON.parse(text)
}

type HeadersInput = HeadersInit | Record<string, string | undefined> | undefined

function mergeHeaders(a: HeadersInput, b: HeadersInput): Record<string, string> {
  const out: Record<string, string> = {}
  copyHeadersInto(out, a)
  copyHeadersInto(out, b)
  return out
}

function copyHeadersInto(out: Record<string, string>, source: unknown): void {
  if (source == null) return
  // Allow Headers / [string,string][] / Record at the public boundary —
  // value-undefined silently drops the key (so `{ auth: token ?? undefined }`
  // doesn't blow up).
  const entries: [string, unknown][] =
    source instanceof Headers
      ? [...source.entries()]
      : Array.isArray(source)
        ? (source as [string, unknown][])
        : Object.entries(source as Record<string, unknown>)
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue
    out[validateHeaderName(k)] = validateHeaderValue(String(v))
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code === 13 || code === 10 || code === 0) return true
  }
  return false
}

function validateHeaderName(name: string): string {
  if (hasControlChar(name)) {
    throw new Error(`misina: invalid header name (control character): ${JSON.stringify(name)}`)
  }
  return name.toLowerCase()
}

function validateHeaderValue(value: string): string {
  if (hasControlChar(value)) {
    throw new Error("misina: invalid header value (control character — request smuggling guard)")
  }
  return value
}

async function buildRequest(
  options: MisinaResolvedOptions,
  totalSignal: AbortSignal | undefined,
): Promise<Request> {
  const headers = { ...options.headers }
  const method = options.method
  const init: RequestInit & {
    duplex?: "half"
    next?: { revalidate?: number | false; tags?: string[] }
  } = {
    method,
    headers,
    signal: composeSignals([options.signal, totalSignal]),
  }
  if (options.cache !== undefined) init.cache = options.cache
  if (options.credentials !== undefined) init.credentials = options.credentials
  if (options.next !== undefined) init.next = options.next
  if (options.priority !== undefined) {
    ;(init as RequestInit & { priority?: "high" | "low" | "auto" }).priority = options.priority
  }

  if (isPayloadMethod(method) && options.body !== undefined) {
    const serialized = serializeBody(options.body, headers, options.stringifyJson)
    if (serialized !== undefined && serialized !== null) {
      if (options.onUploadProgress && supportsRequestStreams()) {
        const wrapped = await progressUpload(serialized, options.onUploadProgress)
        init.body = wrapped.body
        init.duplex = "half"
      } else {
        init.body = serialized
        if (serialized instanceof ReadableStream) init.duplex = "half"
      }
    }
    init.headers = headers
  }

  return new Request(options.url, init)
}

function buildAttemptSignal(
  options: MisinaResolvedOptions,
  totalSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals: (AbortSignal | undefined)[] = [options.signal, totalSignal]
  if (options.timeout !== false && options.timeout > 0) {
    signals.push(timeoutSignal(options.timeout))
  }
  return composeSignals(signals)
}

function withSignal(request: Request, signal: AbortSignal | undefined): Request {
  if (!signal) return request
  // ReadableStream bodies require explicit `duplex: 'half'` when re-wrapping.
  const init: RequestInit & { duplex?: "half" } = { signal }
  if (request.body instanceof ReadableStream) init.duplex = "half"
  return new Request(request, init)
}

function computeDeadline(totalTimeout: number | false): number | undefined {
  if (!totalTimeout || totalTimeout <= 0) return undefined
  return Date.now() + totalTimeout
}

function deadlineSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now()
  return timeoutSignal(Math.max(0, remaining))
}

async function applyDefer(
  options: MisinaResolvedOptions,
  defaults: MisinaOptions,
  init: MisinaRequestInit,
): Promise<void> {
  const callbacks = [
    ...(Array.isArray(defaults.defer) ? defaults.defer : defaults.defer ? [defaults.defer] : []),
    ...(Array.isArray(init.defer) ? init.defer : init.defer ? [init.defer] : []),
  ]
  if (callbacks.length === 0) return

  for (const callback of callbacks) {
    const patch = await callback(options)
    if (!patch) continue

    if (patch.headers) {
      for (const [k, v] of Object.entries(patch.headers)) {
        options.headers[validateHeaderName(k)] = validateHeaderValue(v)
      }
    }
    if (patch.baseURL !== undefined) options.baseURL = patch.baseURL
    if (patch.timeout !== undefined) options.timeout = patch.timeout
    if (patch.totalTimeout !== undefined) options.totalTimeout = patch.totalTimeout
    if (patch.signal !== undefined) options.signal = patch.signal
    if (patch.responseType !== undefined) options.responseType = patch.responseType
    if (patch.throwHttpErrors !== undefined) options.throwHttpErrors = patch.throwHttpErrors
    if (patch.parseJson !== undefined) options.parseJson = patch.parseJson
    if (patch.stringifyJson !== undefined) options.stringifyJson = patch.stringifyJson
  }

  // Re-resolve URL in case headers changed query/baseURL semantics
  // (we don't change url after defer for now — defer is for headers/timing primarily)
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "QUERY"])

function applyIdempotencyKey(request: Request, options: MisinaResolvedOptions): Request {
  const policy = options.idempotencyKey
  if (policy === false || policy == null) return request
  // Only worth setting on methods that aren't already idempotent. PUT is
  // idempotent by spec; POST/PATCH/DELETE are the targets.
  if (IDEMPOTENT_METHODS.has(options.method)) return request
  if (options.retry.limit <= 0) return request
  // User-supplied key takes precedence — don't overwrite.
  if (request.headers.has("idempotency-key")) return request

  const value =
    policy === "auto"
      ? crypto.randomUUID()
      : typeof policy === "function"
        ? policy(request)
        : policy

  const headers = new Headers(request.headers)
  headers.set("idempotency-key", value)
  const init: RequestInit & { duplex?: "half" } = { headers }
  if (request.body instanceof ReadableStream) init.duplex = "half"
  return new Request(request, init)
}

async function parseResponseBodyTolerant(
  response: Response,
  options: MisinaResolvedOptions,
  ctx: MisinaContext,
): Promise<unknown> {
  try {
    return await parseResponseBody(
      response,
      options.method,
      options.parseJson,
      options.responseType,
      ctx.request,
    )
  } catch {
    // Malformed body on an error response: fall back to raw text so the
    // caller still gets an HTTPError with whatever the server actually sent.
    try {
      return await response.clone().text()
    } catch {
      return undefined
    }
  }
}

function abortReasonAsError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  if (reason instanceof Error) return reason
  const error = new DOMException(
    typeof reason === "string" ? reason : "The operation was aborted",
    "AbortError",
  )
  return error
}

function mapTransportError(
  cause: unknown,
  signal: AbortSignal | undefined,
  url: string,
  timeout: number | undefined,
): Error {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || isOurTimeoutAbort(signal)) {
      return new TimeoutError(timeout ?? 0, { cause })
    }
    if (cause.name === "AbortError") {
      return cause
    }
  }
  if (isRawNetworkError(cause)) {
    return new NetworkError(`Network request to ${url} failed`, { cause })
  }
  return cause as Error
}

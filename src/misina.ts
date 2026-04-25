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
    const originalRequest = ctx.request
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
    const data = await parseResponseBody(
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
    return current
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
  const headers = mergeHeaders(defaults.headers, init.headers)
  const arrayFormat = init.arrayFormat ?? defaults.arrayFormat ?? "repeat"
  const paramsSerializer = init.paramsSerializer ?? defaults.paramsSerializer
  const url = appendQuery(
    resolveUrl(input, baseURL, allowAbsoluteUrls),
    init.query,
    arrayFormat,
    paramsSerializer,
  )

  const body = METHODS_WITHOUT_BODY.includes(method) ? undefined : init.body

  return {
    url,
    allowAbsoluteUrls,
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

function mergeHeaders(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (a) for (const [k, v] of Object.entries(a)) out[validateHeaderName(k)] = validateHeaderValue(v)
  if (b) for (const [k, v] of Object.entries(b)) out[validateHeaderName(k)] = validateHeaderValue(v)
  return out
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

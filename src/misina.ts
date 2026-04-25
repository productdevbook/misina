import { isPayloadMethod, parseResponseBody, serializeBody } from "./_body.ts"
import { mergeHooks } from "./_hooks.ts"
import { appendQuery, resolveUrl } from "./_url.ts"
import fetchDriverFactory from "./driver/fetch.ts"
import { HTTPError, isRawNetworkError, NetworkError } from "./errors/index.ts"
import type {
  HttpMethod,
  Misina,
  MisinaContext,
  MisinaDriver,
  MisinaOptions,
  MisinaRequestInit,
  MisinaResolvedOptions,
  MisinaResponse,
} from "./types.ts"

const METHODS_WITHOUT_BODY: HttpMethod[] = ["GET", "DELETE", "HEAD", "OPTIONS"]

export function createMisina(defaults: MisinaOptions = {}): Misina {
  const driver: MisinaDriver =
    defaults.driver ?? fetchDriverFactory({ fetch: defaults.fetch } as never)

  async function request<T = unknown>(
    input: string,
    init: MisinaRequestInit = {},
  ): Promise<MisinaResponse<T>> {
    const options = resolveOptions(input, init, defaults)

    for (const initHook of options.hooks.init) initHook(options)

    let request = buildRequest(options)
    const ctx: MisinaContext = { request, options, attempt: 0 }

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

    let response: Response
    try {
      response = await driver.request(ctx.request)
    } catch (cause) {
      const error = isRawNetworkError(cause)
        ? new NetworkError(`Network request to ${request.url} failed`, { cause })
        : (cause as Error)
      throw await runBeforeError(error, ctx)
    }

    ctx.response = response

    for (const hook of options.hooks.afterResponse) {
      const out = await hook(ctx)
      if (out instanceof Response) {
        ctx.response = out
        response = out
      }
    }

    return finalizeResponse<T>(response, ctx)
  }

  async function finalizeResponse<T>(
    response: Response,
    ctx: MisinaContext,
  ): Promise<MisinaResponse<T>> {
    const { options } = ctx
    const data = await parseResponseBody(response, options.method, options.responseType)

    if (options.throwHttpErrors && !response.ok) {
      const error = new HTTPError(response, ctx.request, data)
      throw await runBeforeError(error, ctx)
    }

    return {
      data: data as T,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      url: response.url || ctx.request.url,
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

  const misina: Misina = {
    request,
    get: (url, init) => request(url, { ...init, method: "GET" }),
    post: (url, body, init) => request(url, { ...init, method: "POST", body }),
    put: (url, body, init) => request(url, { ...init, method: "PUT", body }),
    patch: (url, body, init) => request(url, { ...init, method: "PATCH", body }),
    delete: (url, init) => request(url, { ...init, method: "DELETE" }),
    head: (url, init) => request(url, { ...init, method: "HEAD" }),
    options: (url, init) => request(url, { ...init, method: "OPTIONS" }),
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
  const headers = mergeHeaders(defaults.headers, init.headers)
  const url = appendQuery(resolveUrl(input, baseURL), init.query)

  const body = METHODS_WITHOUT_BODY.includes(method) ? undefined : init.body

  return {
    url,
    method,
    headers,
    body,
    query: init.query,
    baseURL,
    timeout: init.timeout ?? defaults.timeout,
    signal: init.signal ?? defaults.signal,
    responseType: init.responseType ?? defaults.responseType,
    hooks: mergeHooks(defaults.hooks, init.hooks),
    throwHttpErrors: init.throwHttpErrors ?? defaults.throwHttpErrors ?? true,
  }
}

function mergeHeaders(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (a) for (const [k, v] of Object.entries(a)) out[k.toLowerCase()] = v
  if (b) for (const [k, v] of Object.entries(b)) out[k.toLowerCase()] = v
  return out
}

function buildRequest(options: MisinaResolvedOptions): Request {
  const headers = { ...options.headers }
  const method = options.method
  const init: RequestInit = {
    method,
    headers,
    signal: options.signal,
  }

  if (isPayloadMethod(method) && options.body !== undefined) {
    const serialized = serializeBody(options.body, headers)
    if (serialized !== undefined) init.body = serialized
    init.headers = headers
  }

  return new Request(options.url, init)
}

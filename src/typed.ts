/**
 * Type-only path generics. Pass an Endpoints map to `createMisina` to get
 * IntelliSense on URL, method, params, query, body, and response.
 *
 * ```ts
 * type Api = {
 *   "GET /users/:id": { params: { id: string }; response: User }
 *   "POST /users":    { body: NewUser; response: User }
 * }
 *
 * const api = createMisinaTyped<Api>()
 * const user = await api.get("/users/:id", { params: { id: "42" } })
 * //         ^? User
 * ```
 *
 * Runtime path-param substitution is performed: `/users/:id` → `/users/42`.
 */

import { createMisina } from "./misina.ts"
import { HTTPError } from "./errors/http.ts"
import type {
  Misina,
  MisinaOptions,
  MisinaRequestInit,
  MisinaResponse,
  MisinaResponsePromise,
} from "./types.ts"

export interface EndpointDef {
  params?: Record<string, string | number>
  query?: Record<string, unknown>
  body?: unknown
  response?: unknown
  responses?: Record<number, unknown>
}

export type EndpointsMap = Record<string, EndpointDef>

/** 2xx codes recognized as success branches by `.safe.*` typed results. */
export type SuccessCodes = 200 | 201 | 202 | 204
/** 4xx/5xx codes recognized as error branches by `.safe.*` typed results. */
export type ErrorCodes = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 502 | 503

/**
 * Normalize an `EndpointDef`'s response declaration into a `Record<number, _>`
 * map. `responses` wins; otherwise `response: T` becomes `{ 200: T }`; an
 * endpoint with neither falls back to `Record<number, unknown>`.
 */
export type ResponsesOf<D> = D extends { responses: infer R }
  ? R
  : D extends { response: infer T }
    ? { 200: T }
    : Record<number, unknown>

export type SuccessBodyOf<R> = [keyof R & SuccessCodes] extends [never]
  ? unknown
  : { [K in keyof R & SuccessCodes]: R[K] }[keyof R & SuccessCodes]

export type TypedSafeOk<R> = {
  ok: true
  data: SuccessBodyOf<R>
  status: keyof R & SuccessCodes
  response: Response
  error?: undefined
}

/**
 * Per-status HTTP error branch. The server responded with a status the
 * endpoint declared as an error — `error.status` narrows to the union of
 * declared `ErrorCodes`, and `error.data` narrows to the body shape for
 * that status.
 */
export type TypedSafeHttpErr<R> = {
  ok: false
  kind: "http"
  data?: undefined
  error: [keyof R & ErrorCodes] extends [never]
    ? { status: number; data: unknown }
    : { [K in keyof R & ErrorCodes]: { status: K; data: R[K] } }[keyof R & ErrorCodes]
  response: Response
}

/**
 * Network / timeout / abort branch. The request never received a server
 * response — there is no HTTP status to discriminate on. `error` is the
 * raw thrown `Error` (TypeError, TimeoutError, etc.); `response` is
 * `undefined`.
 */
export type TypedSafeNetworkErr = {
  ok: false
  kind: "network"
  data?: undefined
  error: Error
  response: undefined
}

/**
 * Discriminated union covering both error branches. Use `result.kind` to
 * separate the wire-level HTTP error (where `result.error.status` is a
 * declared `ErrorCodes`) from the transport-level failure (where
 * `result.error` is a raw `Error`).
 */
export type TypedSafeErr<R> = TypedSafeHttpErr<R> | TypedSafeNetworkErr

export type TypedSafeResult<R> = TypedSafeOk<R> | TypedSafeErr<R>

type Method<S extends string> = S extends `${infer M} ${string}` ? M : never
type Path<S extends string> = S extends `${string} ${infer P}` ? P : never

type EndpointsOfMethod<E extends EndpointsMap, M extends string> = {
  [K in keyof E & string as Method<K> extends M ? Path<K> : never]: E[K]
}

type CallInit<E> = Omit<MisinaOptions, "headers"> & {
  headers?: Record<string, string>
} & (E extends { params: infer P } ? { params: P } : {}) &
  (E extends { query: infer Q } ? { query: Q } : { query?: Record<string, unknown> }) &
  (E extends { body: infer B } ? { body: B } : {})

type ResponsePromise<E> = MisinaResponsePromise<SuccessBodyOf<ResponsesOf<E>>>

// True when the endpoint has no required `params`, `query`, or `body`. In
// that case the call's `init` argument should be optional so users can write
// `api.get('/health')` instead of `api.get('/health', {})`.
type HasRequiredFields<E> = E extends { params: unknown }
  ? true
  : E extends { query: unknown }
    ? true
    : E extends { body: unknown }
      ? true
      : false

type CallArgs<E> = HasRequiredFields<E> extends true ? [init: CallInit<E>] : [init?: CallInit<E>]

export interface TypedSafeMisina<E extends EndpointsMap> {
  get: <P extends keyof EndpointsOfMethod<E, "GET"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "GET">[P]>
  ) => Promise<TypedSafeResult<ResponsesOf<EndpointsOfMethod<E, "GET">[P]>>>
  post: <P extends keyof EndpointsOfMethod<E, "POST"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "POST">[P]>
  ) => Promise<TypedSafeResult<ResponsesOf<EndpointsOfMethod<E, "POST">[P]>>>
  put: <P extends keyof EndpointsOfMethod<E, "PUT"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PUT">[P]>
  ) => Promise<TypedSafeResult<ResponsesOf<EndpointsOfMethod<E, "PUT">[P]>>>
  patch: <P extends keyof EndpointsOfMethod<E, "PATCH"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PATCH">[P]>
  ) => Promise<TypedSafeResult<ResponsesOf<EndpointsOfMethod<E, "PATCH">[P]>>>
  delete: <P extends keyof EndpointsOfMethod<E, "DELETE"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "DELETE">[P]>
  ) => Promise<TypedSafeResult<ResponsesOf<EndpointsOfMethod<E, "DELETE">[P]>>>
}

export interface TypedMisina<E extends EndpointsMap> {
  raw: Misina
  safe: TypedSafeMisina<E>
  get: <P extends keyof EndpointsOfMethod<E, "GET"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "GET">[P]>
  ) => ResponsePromise<EndpointsOfMethod<E, "GET">[P]>
  post: <P extends keyof EndpointsOfMethod<E, "POST"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "POST">[P]>
  ) => ResponsePromise<EndpointsOfMethod<E, "POST">[P]>
  put: <P extends keyof EndpointsOfMethod<E, "PUT"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PUT">[P]>
  ) => ResponsePromise<EndpointsOfMethod<E, "PUT">[P]>
  patch: <P extends keyof EndpointsOfMethod<E, "PATCH"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PATCH">[P]>
  ) => ResponsePromise<EndpointsOfMethod<E, "PATCH">[P]>
  delete: <P extends keyof EndpointsOfMethod<E, "DELETE"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "DELETE">[P]>
  ) => ResponsePromise<EndpointsOfMethod<E, "DELETE">[P]>
}

export function createMisinaTyped<E extends EndpointsMap>(
  defaults: MisinaOptions = {},
): TypedMisina<E> {
  const raw = createMisina(defaults)

  function resolveUrl(path: string, init: Record<string, unknown>): string {
    const params = init.params as Record<string, string | number> | undefined
    return params ? substitutePathParams(path, params) : path
  }

  function buildOptions(method: string, init: Record<string, unknown>): MisinaRequestInit {
    const { params: _omit, body, ...rest } = init
    void _omit
    if (method === "GET" || method === "DELETE" || method === "HEAD" || method === "OPTIONS") {
      return { ...(rest as MisinaRequestInit), method: method as "GET" }
    }
    return { ...(rest as MisinaRequestInit), method: method as "POST", body }
  }

  function call<R>(
    method: string,
    path: string,
    init: Record<string, unknown> = {},
  ): MisinaResponsePromise<R> {
    return raw.request<R>(resolveUrl(path, init), buildOptions(method, init))
  }

  type LooseSafeResult =
    | { ok: true; data: unknown; status: number; response: Response; error?: undefined }
    | {
        ok: false
        kind: "http"
        data?: undefined
        error: { status: number; data: unknown }
        response: Response
      }
    | {
        ok: false
        kind: "network"
        data?: undefined
        error: Error
        response: undefined
      }

  async function safeCall(
    method: string,
    path: string,
    init: Record<string, unknown> = {},
  ): Promise<LooseSafeResult> {
    try {
      const res = await raw.request<unknown>(resolveUrl(path, init), buildOptions(method, init))
      return { ok: true, data: res.data, status: res.status, response: res.raw }
    } catch (e) {
      if (e instanceof HTTPError) {
        return {
          ok: false,
          kind: "http",
          error: { status: e.status, data: e.data },
          response: e.response,
        }
      }
      // Network / timeout / abort / anything non-HTTP. There is no server
      // response to discriminate on, so surface the raw `Error` and let
      // the caller branch on `kind === "network"`. Rethrowing would
      // defeat .safe's purpose; coercing into a fake `status: 0` would
      // lie about the typed `ErrorCodes` union. Drivers and internal code
      // throw `Error` subclasses per AGENTS.md ("drivers throw
      // TypeError('fetch failed')"), so no defensive coercion here.
      return {
        ok: false,
        kind: "network",
        error: e as Error,
        response: undefined,
      }
    }
  }

  const make =
    (method: string) =>
    (path: string, init?: Record<string, unknown>): MisinaResponsePromise<unknown> =>
      call(method, path, init)

  const makeSafe =
    (method: string) =>
    (path: string, init?: Record<string, unknown>): Promise<LooseSafeResult> =>
      safeCall(method, path, init)

  const safe = {
    get: makeSafe("GET"),
    post: makeSafe("POST"),
    put: makeSafe("PUT"),
    patch: makeSafe("PATCH"),
    delete: makeSafe("DELETE"),
  } as unknown as TypedSafeMisina<E>

  return {
    raw,
    safe,
    get: make("GET") as TypedMisina<E>["get"],
    post: make("POST") as TypedMisina<E>["post"],
    put: make("PUT") as TypedMisina<E>["put"],
    patch: make("PATCH") as TypedMisina<E>["patch"],
    delete: make("DELETE") as TypedMisina<E>["delete"],
  }
}

/**
 * Extract path-parameter names from a literal template, supporting both
 * `:name` and `{name}` syntaxes. Used by `path()` to type the params arg.
 */
export type PathParamsOf<T extends string> = T extends `${string}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof PathParamsOf<`/${Rest}`>]: string | number }
  : T extends `${string}:${infer Param}`
    ? { [K in Param]: string | number }
    : T extends `${string}{${infer Param}}${infer Rest}`
      ? { [K in Param | keyof PathParamsOf<Rest>]: string | number }
      : Record<string, never>

/**
 * Build a path string from a template + params. Substitutes `:name` and
 * `{name}` placeholders. Rejects values that would escape the template
 * (`..`, `/`, `\`, NUL, CR/LF) per misina's security model.
 *
 * @example
 * ```ts
 * import { path } from "misina"
 *
 * path("/users/:id/posts/:postId", { id: "42", postId: "7" })
 * // → "/users/42/posts/7"
 * ```
 */
export function path<T extends string>(
  template: T,
  params: PathParamsOf<T> & Record<string, string | number>,
): string {
  return substitutePathParams(template, params as Record<string, string | number>)
}

export function substitutePathParams(
  path: string,
  params: Record<string, string | number>,
): string {
  return path
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
      const value = params[key]
      if (value == null) {
        throw new Error(`misina: missing path param :${key} for ${path}`)
      }
      return safePathParam(String(value), key, path)
    })
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      const value = params[key]
      if (value == null) {
        throw new Error(`misina: missing path param {${key}} for ${path}`)
      }
      return safePathParam(String(value), key, path)
    })
}

function safePathParam(value: string, key: string, path: string): string {
  // Reject path traversal & separators. encodeURIComponent does encode `/`,
  // `\`, `\0` — but `..` is literal-legal and would still be normalized by
  // WHATWG URL into a parent segment. Reject the value early so the URL
  // composition can't escape its template.
  if (value === ".." || value === "." || value === "") {
    throw new Error(
      `misina: path param ${key} value ${JSON.stringify(value)} rejected (traversal) for ${path}`,
    )
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(
      `misina: path param ${key} contains separator (/, \\, NUL) — value ${JSON.stringify(value)} for ${path}`,
    )
  }
  // CR/LF already caught upstream (#52); double-check at this layer.
  if (value.includes("\r") || value.includes("\n")) {
    throw new Error(`misina: path param ${key} contains CR/LF for ${path}`)
  }
  return encodeURIComponent(value)
}

/**
 * Standard Schema (https://standardschema.dev) validation helper. Pass any
 * standard-schema validator (zod, valibot, arktype) to validate a parsed
 * response body.
 */
export async function validateSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
): Promise<T> {
  const result = await schema["~standard"].validate(value)
  if ("issues" in result && result.issues) {
    throw new SchemaValidationError(formatSchemaMessage(result.issues), result.issues)
  }
  return (result as { value: T }).value
}

function formatSchemaMessage(issues: ReadonlyArray<StandardIssue>): string {
  if (issues.length === 0) return "Schema validation failed"
  const head = issues[0]
  if (!head) return "Schema validation failed"
  const where =
    head.path && head.path.length > 0
      ? ` at ${head.path.map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".")}`
      : ""
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ""
  return `Schema validation failed${where}: ${head.message}${more}`
}

/**
 * Per the [Standard Schema v1 spec](https://standardschema.dev), an
 * issue's `path` is a sequence of either bare PropertyKeys or
 * `{ key: PropertyKey }` objects (so vendors can attach extra metadata
 * like `type` for tuple/intersection/union narrowing).
 */
export type StandardPathItem = PropertyKey | { key: PropertyKey }

export interface StandardIssue {
  message: string
  path?: ReadonlyArray<StandardPathItem>
}

export interface StandardSchemaV1<I = unknown, O = unknown> {
  "~standard": {
    version: 1
    vendor: string
    validate: (
      value: unknown,
    ) =>
      | { value: O; issues?: undefined }
      | { issues: ReadonlyArray<StandardIssue> }
      | Promise<{ value: O; issues?: undefined } | { issues: ReadonlyArray<StandardIssue> }>
    types?: { input: I; output: O }
  }
}

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError"
  readonly issues: ReadonlyArray<StandardIssue>

  constructor(message: string, issues: ReadonlyArray<StandardIssue>) {
    super(message)
    this.issues = issues
  }
}

export function isSchemaValidationError(error: unknown): error is SchemaValidationError {
  return error instanceof SchemaValidationError
}

/**
 * Wrap a `MisinaResponse.data` with a Standard Schema validator. Throws
 * `SchemaValidationError` on mismatch.
 */
export async function validated<T>(
  promise: Promise<MisinaResponse<unknown>>,
  schema: StandardSchemaV1<unknown, T>,
): Promise<MisinaResponse<T>> {
  const res = await promise
  const data = await validateSchema(schema, res.data)
  return { ...res, data }
}

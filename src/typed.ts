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
import type { Misina, MisinaOptions, MisinaResponse, MisinaResponsePromise } from "./types.ts"

export interface EndpointDef {
  params?: Record<string, string | number>
  query?: Record<string, unknown>
  body?: unknown
  response?: unknown
}

export type EndpointsMap = Record<string, EndpointDef>

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

type Response<E> = MisinaResponsePromise<E extends { response: infer R } ? R : unknown>

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

export interface TypedMisina<E extends EndpointsMap> {
  raw: Misina
  get: <P extends keyof EndpointsOfMethod<E, "GET"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "GET">[P]>
  ) => Response<EndpointsOfMethod<E, "GET">[P]>
  post: <P extends keyof EndpointsOfMethod<E, "POST"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "POST">[P]>
  ) => Response<EndpointsOfMethod<E, "POST">[P]>
  put: <P extends keyof EndpointsOfMethod<E, "PUT"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PUT">[P]>
  ) => Response<EndpointsOfMethod<E, "PUT">[P]>
  patch: <P extends keyof EndpointsOfMethod<E, "PATCH"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "PATCH">[P]>
  ) => Response<EndpointsOfMethod<E, "PATCH">[P]>
  delete: <P extends keyof EndpointsOfMethod<E, "DELETE"> & string>(
    path: P,
    ...args: CallArgs<EndpointsOfMethod<E, "DELETE">[P]>
  ) => Response<EndpointsOfMethod<E, "DELETE">[P]>
}

export function createMisinaTyped<E extends EndpointsMap>(
  defaults: MisinaOptions = {},
): TypedMisina<E> {
  const raw = createMisina(defaults)

  function call<R>(
    method: string,
    path: string,
    init: Record<string, unknown> = {},
  ): MisinaResponsePromise<R> {
    const params = init.params as Record<string, string | number> | undefined
    const url = params ? substitutePathParams(path, params) : path
    const { params: _omit, body, ...rest } = init
    void _omit
    if (method === "GET" || method === "DELETE" || method === "HEAD" || method === "OPTIONS") {
      return raw.request<R>(url, { ...(rest as MisinaOptions), method: method as "GET" })
    }
    return raw.request<R>(url, {
      ...(rest as MisinaOptions),
      method: method as "POST",
      body,
    })
  }

  const make =
    (method: string) =>
    (path: string, init?: Record<string, unknown>): MisinaResponsePromise<unknown> =>
      call(method, path, init)

  return {
    raw,
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

function formatSchemaMessage(
  issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>,
): string {
  if (issues.length === 0) return "Schema validation failed"
  const head = issues[0]
  if (!head) return "Schema validation failed"
  const where = head.path && head.path.length > 0 ? ` at ${head.path.join(".")}` : ""
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ""
  return `Schema validation failed${where}: ${head.message}${more}`
}

export interface StandardSchemaV1<I = unknown, O = unknown> {
  "~standard": {
    version: 1
    vendor: string
    validate: (
      value: unknown,
    ) =>
      | { value: O; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
      | Promise<
          | { value: O; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> }
        >
    types?: { input: I; output: O }
  }
}

export class SchemaValidationError extends Error {
  override readonly name = "SchemaValidationError"
  readonly issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>

  constructor(
    message: string,
    issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }>,
  ) {
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

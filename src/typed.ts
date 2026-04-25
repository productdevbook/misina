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

function substitutePathParams(path: string, params: Record<string, string | number>): string {
  return path
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
      const value = params[key]
      if (value == null) {
        throw new Error(`misina: missing path param :${key} for ${path}`)
      }
      return encodeURIComponent(String(value))
    })
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      const value = params[key]
      if (value == null) {
        throw new Error(`misina: missing path param {${key}} for ${path}`)
      }
      return encodeURIComponent(String(value))
    })
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
    const error = new SchemaValidationError("Schema validation failed", result.issues)
    throw error
  }
  return (result as { value: T }).value
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

/**
 * Type-only OpenAPI adapter. Converts the `paths` type produced by
 * [openapi-typescript](https://github.com/openapi-ts/openapi-typescript)
 * (and other tools that emit the same shape) into a misina `EndpointsMap`
 * that `createMisinaTyped` understands.
 *
 * Zero runtime cost — this file ships only declarations.
 *
 * ```ts
 * import { createMisinaTyped } from "misina"
 * import type { OpenApiEndpoints } from "misina/openapi"
 * import type { paths } from "./generated.d.ts"
 *
 * const api = createMisinaTyped<OpenApiEndpoints<paths>>({ baseURL })
 * const u = await api.get("/users/{id}", { params: { id: "42" } })
 * ```
 *
 * @module
 */

import type { EndpointDef } from "../typed.ts"

// ─── openapi-typescript output shape ──────────────────────────────────────
//
// We match its structural shape rather than importing types from the package
// so misina stays zero-dep. If a different generator emits the same shape it
// will work too.

type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace"

type JsonContent = { "application/json": unknown }

type ContentOf<T> = T extends { content: infer C } ? C : never

type JsonOf<T> = T extends { content: infer C }
  ? C extends { "application/json": infer J }
    ? J
    : never
  : never

interface OperationLike {
  parameters?: {
    path?: Record<string, unknown>
    query?: Record<string, unknown>
    header?: Record<string, unknown>
    cookie?: Record<string, unknown>
  }
  requestBody?: {
    content?: JsonContent
  }
  responses?: Record<string | number, { content?: JsonContent } | undefined>
}

type PathItemLike = Partial<Record<HttpMethod, OperationLike>>

type PathsLike = Record<string, PathItemLike>

// ─── extraction helpers ───────────────────────────────────────────────────

type PickResponse<R> =
  R extends Record<string | number, unknown>
    ? R extends { 200: infer R200 }
      ? JsonOf<R200>
      : R extends { 201: infer R201 }
        ? JsonOf<R201>
        : R extends { 204: unknown }
          ? undefined
          : R extends { default: infer RDef }
            ? JsonOf<RDef>
            : unknown
    : unknown

type ParamsOf<Op> = Op extends { parameters: { path: infer P } }
  ? [keyof P] extends [never]
    ? never
    : P
  : never

type QueryOf<Op> = Op extends { parameters: { query: infer Q } }
  ? [keyof Q] extends [never]
    ? never
    : Q
  : never

type BodyOf<Op> = Op extends { requestBody: { content: infer C } }
  ? C extends JsonContent
    ? C["application/json"]
    : ContentOf<{ content: C }>
  : never

type ResponseOf<Op> = Op extends { responses: infer R } ? PickResponse<R> : unknown

type EndpointFor<Op> = Op extends OperationLike
  ? // Build EndpointDef without including never-valued keys, so users don't
    // have to pass `params: never` etc. when an operation has no params.
    (ParamsOf<Op> extends never ? Record<string, never> : { params: ParamsOf<Op> }) &
      (QueryOf<Op> extends never ? Record<string, never> : { query: QueryOf<Op> }) &
      (BodyOf<Op> extends never ? Record<string, never> : { body: BodyOf<Op> }) & {
        response: ResponseOf<Op>
      }
  : never

// ─── public adapter ───────────────────────────────────────────────────────

/**
 * All `(path, verb)` pairs flattened into a union of `{ key, op }` records,
 * one per operation. Distributing over a union here keeps each entry's
 * operation type linked to the exact verb instead of collapsing into a union
 * of all verbs in that path.
 */
type Flatten<Paths extends PathsLike> = {
  [P in keyof Paths & string]: {
    [M in HttpMethod & keyof Paths[P]]: { key: `${Uppercase<M>} ${P}`; op: Paths[P][M] }
  }[HttpMethod & keyof Paths[P]]
}[keyof Paths & string]

/**
 * Convert an openapi-typescript-shaped `paths` type into a misina
 * `EndpointsMap`. Each `PATH × METHOD` pair becomes a key like
 * `"GET /users/{id}"` mapping to `{ params, query, body, response }`.
 *
 * Operations without `parameters.path` / `parameters.query` / `requestBody`
 * have those keys omitted so callers don't need to pass them.
 */
export type OpenApiEndpoints<Paths extends PathsLike> = {
  [E in Flatten<Paths> as E["key"]]: EndpointFor<E["op"]>
}

// Re-export EndpointDef so users see one import surface.
export type { EndpointDef, EndpointsMap } from "../typed.ts"

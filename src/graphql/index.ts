/**
 * GraphQL helper. Wraps a `Misina` instance with `query` / `mutate`
 * methods that send the canonical `{ query, variables }` envelope.
 *
 * Optional Apollo Automatic Persisted Queries (APQ): the client sends
 * the SHA-256 hash of the query first; the server returns
 * `PersistedQueryNotFound` if it hasn't seen it yet, and the client
 * retries with the full query attached.
 *
 * Optional GET fallback: short queries can be sent as GET (URL-encoded)
 * to take advantage of CDN caching. Auto-disabled for mutations and
 * for queries above ~1500 chars (URL length safety).
 *
 * @example
 * ```ts
 * import { withGraphql } from "misina/graphql"
 *
 * const gql = withGraphql(createMisina({ baseURL }), { endpoint: "/graphql" })
 * const data = await gql.query<User>(`query GetUser($id: ID!) { user(id: $id) { id name } }`, { id: "42" })
 * ```
 */

import type { Misina } from "../types.ts"

export interface GraphqlOptions {
  /** Endpoint path appended to the misina baseURL. Default: '/graphql'. */
  endpoint?: string
  /**
   * Enable Apollo Automatic Persisted Queries. Default: false. When on,
   * the client sends only the SHA-256 hash; if the server replies with
   * `PersistedQueryNotFound`, the client retries with the full query.
   */
  persistedQueries?: boolean
  /**
   * Send queries as GET when the URL would stay below this many chars.
   * Default: 0 (disabled). Mutations always use POST.
   */
  getFallbackBelow?: number
}

export interface GraphqlClient {
  /** Run a query (read). May use GET fallback when configured. */
  query<TData = unknown, TVars = Record<string, unknown>>(
    query: string,
    variables?: TVars,
    options?: GraphqlCallOptions,
  ): Promise<TData>
  /** Run a mutation (write). Always POST. */
  mutate<TData = unknown, TVars = Record<string, unknown>>(
    query: string,
    variables?: TVars,
    options?: GraphqlCallOptions,
  ): Promise<TData>
}

export interface GraphqlCallOptions {
  /** Operation name to send in the request envelope. */
  operationName?: string
  /** Per-call extras merged onto the misina init. */
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface GraphqlError {
  message: string
  path?: Array<string | number>
  extensions?: { code?: string; [key: string]: unknown }
  [key: string]: unknown
}

export class GraphqlAggregateError extends Error {
  override readonly name = "GraphqlAggregateError"
  readonly errors: GraphqlError[]
  readonly data: unknown

  constructor(errors: GraphqlError[], data: unknown) {
    super(errors[0]?.message ?? "GraphQL request failed")
    this.errors = errors
    this.data = data
  }
}

export function withGraphql(misina: Misina, options: GraphqlOptions = {}): GraphqlClient {
  const endpoint = options.endpoint ?? "/graphql"
  const apq = options.persistedQueries ?? false
  const getFallbackBelow = options.getFallbackBelow ?? 0

  async function exec<TData>(
    query: string,
    variables: unknown,
    callOptions: GraphqlCallOptions | undefined,
    isMutation: boolean,
  ): Promise<TData> {
    const operationName = callOptions?.operationName
    const headers = { ...(callOptions?.headers ?? {}) }
    const signal = callOptions?.signal

    if (apq) {
      const hash = await sha256Hex(query)
      const extensions = { persistedQuery: { version: 1, sha256Hash: hash } }
      // Hash-only attempt first.
      const hashOnly = {
        query: undefined as string | undefined,
        variables,
        operationName,
        extensions,
      }
      const hashResult = await dispatch<TData>(
        misina,
        endpoint,
        hashOnly,
        headers,
        signal,
        isMutation,
        getFallbackBelow,
      )
      if (!isPersistedQueryNotFound(hashResult.errors)) {
        return finalize<TData>(hashResult)
      }
      // Server doesn't know this hash — resend with full query attached.
      const full = { query, variables, operationName, extensions }
      return finalize<TData>(
        await dispatch<TData>(
          misina,
          endpoint,
          full,
          headers,
          signal,
          isMutation,
          getFallbackBelow,
        ),
      )
    }

    const envelope = { query, variables, operationName }
    return finalize<TData>(
      await dispatch<TData>(
        misina,
        endpoint,
        envelope,
        headers,
        signal,
        isMutation,
        getFallbackBelow,
      ),
    )
  }

  return {
    query: (q, v, o) => exec(q, v, o, false),
    mutate: (q, v, o) => exec(q, v, o, true),
  }
}

interface GraphqlEnvelope {
  query: string | undefined
  variables: unknown
  operationName: string | undefined
  extensions?: unknown
}

interface GraphqlResponse<TData> {
  data?: TData
  errors?: GraphqlError[]
}

async function dispatch<TData>(
  misina: Misina,
  endpoint: string,
  envelope: GraphqlEnvelope,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  isMutation: boolean,
  getFallbackBelow: number,
): Promise<GraphqlResponse<TData>> {
  if (!isMutation && getFallbackBelow > 0) {
    const url = buildGetUrl(endpoint, envelope, getFallbackBelow)
    if (url) {
      const r = await misina.get<GraphqlResponse<TData>>(url, { headers, signal })
      return r.data
    }
  }
  const r = await misina.post<GraphqlResponse<TData>>(endpoint, envelope, { headers, signal })
  return r.data
}

function buildGetUrl(endpoint: string, envelope: GraphqlEnvelope, cap: number): string | undefined {
  if (!envelope.query && !envelope.extensions) return undefined
  const params = new URLSearchParams()
  if (envelope.query) params.set("query", envelope.query)
  if (envelope.operationName) params.set("operationName", envelope.operationName)
  if (envelope.variables !== undefined) params.set("variables", JSON.stringify(envelope.variables))
  if (envelope.extensions !== undefined)
    params.set("extensions", JSON.stringify(envelope.extensions))
  const qs = params.toString()
  if (qs.length > cap) return undefined
  return endpoint.includes("?") ? `${endpoint}&${qs}` : `${endpoint}?${qs}`
}

function isPersistedQueryNotFound(errors: GraphqlError[] | undefined): boolean {
  return !!errors?.some(
    (e) =>
      e.message === "PersistedQueryNotFound" || e.extensions?.code === "PERSISTED_QUERY_NOT_FOUND",
  )
}

function finalize<TData>(response: GraphqlResponse<TData>): TData {
  if (response.errors && response.errors.length > 0) {
    throw new GraphqlAggregateError(response.errors, response.data)
  }
  return response.data as TData
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const bytes = new Uint8Array(hash)
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0")
  }
  return out
}
